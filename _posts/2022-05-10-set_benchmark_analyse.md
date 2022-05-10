---
layout: single
toc: true
classes: wide
---
<style>
    p { font: 0.875rem YaHei !important; }
</style>

# 记一次测试分析(开启 pipeline 时 slave 对 SET 耗时影响)

## 背景介绍

在工作过程中，测试同事反馈在如下 case 中 redis 的 `get` 指令性能要明显优于 `set` 指令性能：

``` shell
    redis-benchmark -h $IP -p $PORT -a $PASSWD -r 4000000 -n 5000000 -t set,get -d 500 -c 500 -P 16
    ......
    78143.31 requests per second // set
    ......
    175389.38 requests per second // get
```

在不指定 “-P” 时 `get` 的性能也要优于 `set`，但并不是如此明显：

``` shell
    redis-benchmark -h $IP -p $PORT -a $PASSWD -r 4000000 -n 5000000 -t set,get -d 500 -c 500 
    ... ...
    43798.95 requests per second // set
    ... ...
    63569.56 requests per second // get
```

下面进行简要分析，client 发送给 redis 的一次请求可以拆分为以下几个阶段：

1. T1: client 发送命令阶段；
2. T2: 物理层网络报文传输延迟；
3. T3: redis server 接收命令阶段；
4. **T4**: redis server 处理命令阶段；
5. T5: redis server 发送 reply 阶段；
6. T6: 物理层网络报文传输延迟；
7. T7: client 接收 reply 阶段；

tps 的计算公式如下：

```
    T = T1 + T2 + T3 + T4 + T5 + T6 + T7
    tps = requests/T
```

在并发客户端数量相同的情况下，指定 `-P 16` 的影响如下：

1. 减少 syscall 的调用数量: 在 redis server 内部实现中调用 [writeToClient](https://github.com/redis/redis/blob/5.0/src/networking.c#L979) 去向对端发送数据，会一次性将缓存区内所有数据调用 `write(2)` 函数写入 `socket`，在 server 内存充足（没有超过最大内存限制 或 未限制最大内存）的情况下，当发送超过 64 KB 数据后会停止发送（如果客户端是 slave则忽略此限制）；在 redis-benchmark 中也是一次性将调用`write(2)`函数写入所有数据，具体的处理过程见**延伸阅读**部分；

2. 提升网络利用率: redis server 与 redis-benchmark 中都关闭了 socket 的 `Nagle` 算法，对小包的传输性能会提升，但是会降低网络利用率。pipeline 将多个命令“合并”发送，可以大幅减少报文数量，减少应答次数，提高网络利用率；

但以上两点影响的是 T1、T3、T5、T7 阶段，T2与T6阶段为物理环境所决定，redis-benchmark 宿主机与 proxy 宿主机、数据库宿主机属于同一网段，网络延迟较低：

``` 
    # redis-benchmark 主机发起 ping
    ping -c 100 $proxy_host
    ... ...
    rtt min/avg/max/mdev = 0.058/0.092/0.172/0.035

    ping -c 100 $db_host
    ... ...
    rtt min/avg/max/mdev = 0.057/0.089/0.178/0.022
```

对于 **T4 阶段**(`redis server` 执行 `set` 和 `get` 命令的耗时)并不会因此而减少，因为总的请求数量不变。通过 redis server 内部的 statistics 信息，可以查看 `set` 与 `get` 命令执行的耗时差距：

```
    > INFO commandstats
    cmdstat_set:calls=425583765,usec=1029939666,usec_per_call=2.42
    cmdstat_get:calls=438697614,usec=840824546,usec_per_call=1.92
```

可以看出 `get` 命令在执行时要明显优于 `set` 命令，但仍未达到测试结果的差距，比较接近不加 `-P` 时的性能差距：

```
    # 非 -P 情况
    set_tps/ get_tps = 43798.95/63569.56 = 0.689
    get_usec_per_call/set_usec_per_call= 1.92/2.42 = 0.79

    # -P 情况
    set_pipeline_tps/get_pipeline_tps = 78143.31/175389.38 = 0.446
```

通过上述的对比，明显可以发现在**T4 阶段**：除去执行命令本身， `get` 命令 case 其他过程要优于 `set` 命令 case。查看 redis server 的源代码可以发现，**在执行 `set` 命令时或其他会修改 `data set` 的命令时，需要将变化传递给 `slave` 和 `aof`[^1]，因此在执行过程中会拖慢 `processCommand` 的速度**。

为此进行了如下测试，对比在 `pipeline` 和 `slave` 两个影响因素下的 tps，结果如下：

```
    # 不开启 slave 时
    # 开启 pipeline
    get: 177405.62 request/s
    set: 118846.71 request/s

    # 不开启 pipeline
    get: 61101.54 request/s
    set: 46511.63 request/s

    # 开启 salve 时
    # 开启 pipeline
    get: 170520.42 request/s
    set: 81866.55 request/s

    # 不开启 pipeline
    get: 61282.02 request/s
    set: 42770.14 request/s

    # 测试指令
    pipeline: redis-benchmark -h $IP -p $PORT -a $PASSWD -r 4000000 -n 5000000 -t set,get -d 500 -c 500 -P 16
    no pipeline: redis-benchmark -h $IP -p $PORT -a $PASSWD -r 4000000 -n 5000000 -t set,get -d 500 -c 500
```

在不开启 slave 的场景（以下简称 no-slave）下：

+ 开启 pipeline 时的读写效率比 `set_rps/get_rps=0.67`；
+ 不开启 pipeline 时的读写效率比 `set_rps/get_rps=0.76`；

在开启 slave 的场景（以下简称 has-slave）下：

+ 开启 pipeline 时的读写效率比 `set_rps/get_rps=0.48`；
+ 不开启 pipeline 时的读写效率比 `set_rps/get_rps=0.69`；

可以清楚的发现在 no-slave 场景，是否开启 pipeline 对读写效率比无较大影响，在*has-slave 场景下，pipeline 对读写效率比影响较大*。对 set 命令 tps 进行横向对比可以发现：**在开启 pipeline 场景下，has-slave 时的 tps 较 no-slave 时下降 30.11%**，这是造成读写效率比下降的最重要原因。

## 根因分析

整个执行期间的时间开销可以分为两部分：on-cpu 和 off-cpu，其中：

+ on-cpu 部分：cpu 执行服务进程处理 command 的耗时，包括内核态、用户态；
+ off-cpu 部分：可以大致分两部分：1、主动触发：syscall 或 锁操作等 导致的 block、io-wait 的时间开销；2、被动触发：系统多任务抢占(例如：时间片耗尽)导致换入、换出 cpu 的延时开销，此外在多核 cpu 的环境下有可能发生 task migrate；

向 `slave` 发送数据在 `beforeSleep` 和 `eventLoop` 阶段完成，向 `aof` 刷写数据都是在 `beforeSleep` 或 `serverCron` 阶段中完成。在整个 `processCommand` 过程中除申请内存外无其他 syscall 调用，线上环境的 redis server 使用 `jemalloc` 进行管理内存。

### on-cpu 分析

redis server 的单事件处理线程模式大大方便了 profile 分析，此处使用 `perf` 工具进行 cpu profile 收集和分析。
has-slave 的结果如下(tps 73606.27)：

``` shell
    ## 此处指定 -t 标识只采集 thread id，避免 redis server 中其他线程的干扰。
    perf record --call-graph dwarf -t $redis_server_pid -- sleep 10
    Samples: 38K of event 'cycles', Event count(approx.): 17854460442
    Children Self  Command       Shared Object Symbol
    - 82.65% 0.00% redis-server  redis-server  [.] aeMain
     - aeMain
        - 80.60% aeProcessEvents
           - 78.69% processInputBuffer
              - 64.70% processCommand
                 - 62.82% call
                    - 24.54% replicationFeedSlaves
                       + 11.40% addReplyBulk
                       + 6.66% addReply
                       + 2.41% feeaReplicationBacklog
                       + 1.82% feedReplicationBacklogWithObject
                         0.50% stringObjectLen
                    + 21.86% setCommand
                    + 16.05% propagate
                 + 1.04% dictFetchValue
              + 12.53% processMultibulkBuffer
              + 1.09% resetClient
           + 1.15% writeToClient
             0.53% readQueryFromClient 
        + 2.04% beforeSleep
```

no-slave 的结果如下(tps 102724.5)：

``` shell
    perf record --call-graph dwarf -t $redis_server_pid -- sleep 10
    Samples: 39K of event 'cycles', Event count(approx.): 18063039903
    Children Self  Command       Shared Object Symbol
    - 77.02% 0.00% redis-server  redis-server  [.] aeMain
     - aeMain
        - 74.59% aeProcessEvents
           - 73.47% processInputBuffer
              - 56.40% processCommand
                 - 53.75% call
                    + 30.44% setCommand
                    + 22.84% propagate
                 + 1.51% dictFetchValue
              + 15.01% processMultibulkBuffer
              + 1.57% resetClient
             0.89% readQueryFromClient
        + 2.43% beforeSleep 
```

采集时间都为 10s，可以明显的看出在 has-slave 的场景下： 新增 replicationFeedSlaves 函数的 cpu 占比 24.54%，主要是在 addReply 和 addReplyBulk 函数，将数据添加到 slave client 的 output buffer 中。这里需要说明的是，perf 在统计中将 replicationFeedSlaves 与 propagate 放在同一层级是与实际源码不符的，实际源码情况 replicationFeedSlaves 是由 progate 函数调用的。

假设执行 `N` 个命令的 cpu 时间开销是不变的 `T`，在 has-slave 的情况下时间开销变为 `(1/0.755)T = 1.325T`，即 tps 下降率为 `24.5%`，而这与实际测试值得下降 `28.3%`仍有一些差距。说明在 has-slave 场景下仍有一些额外的开销，其中一个因素为*发送数据到 slave 的开销*。

这也可以从 `perf report` 的记录中观察出来：

在 has-slave 场景中：

```
    - 16.53% system_call_fastpath
       - 11.25% sys_write
        - 11.10% vfs_write
          - 10.88% do_sync_write
            + 7.17% sock_aio_write
            + 3.67% xfs_file_aio_write # 向 aof 日志写数据
       + 4.86% sys_read
```

在 no-slave 场景中：

```
    - 21.83% system_call_fastpath
       + 13.91% sys_write
       + 7.31% sys_read
       + 0.59% sys_epoll_wait
```

has-slave 的 w/r cpu 比例要高于 no-slave 场景，此处无法判断出有多少 cpu 开销是由于向 slave 同步数据造成的。

综上可以得出**结论1**：在 has-slave 场景下**replicationFeedSlaves 是主要的新增 cpu 开销**（占比 24.5%），此外还有向 slave 发送数据带来的 cpu 开销（占比较少）。

### off-cpu 分析

perf 中用于分析 off-cpu 的命令为 `perf sched`，使用 `perf sched record` 记录进程的调度信息，然后使用 `perf sched timehist` 去进行统计分析[^3]，对输出项的详细说明见[延伸阅读](#延伸阅读)部分

has-slave 的结果如下：

``` shell
    perf sched record -o redis_set_sched.data -- sleep 10

    # 统计 run time
    perf sched timehist -i redis_set_sched.data | grep "\[$pid\]" | awk '{sum += $6}END{print sum}'
    9752.96

    # 统计 wait time
    perf sched timehist -i redis_set_sched.data | grep "\[$pid\]" | awk '{sum += $4}END{print sum}'
    14.903

    # 统计 sch delay
    perf sched timehist -i redis_set_sched.data | grep "\[$pid\]" | awk '{sum += $5}END{print sum}'
    0
```

no-slave 的结果如下：

``` shell
   perf sched record -o redis_set_no_slave_sched.data -- sleep 10

   # 统计 run time
   perf sched timehist -i redis_set_no_slave_sched.data | grep "\[$pid\]" | awk '{sum += $6}END{print sum}' 
   9797.26

   # 统计 wait time
   perf sched timehist -i redis_set_no_slave_sched.data | grep "\[$pid\]" | awk '{sum += $4}END{print sum}' 
   14.546

   # 统计 sch delay
   perf sched timehist -i redis_set_sched.data | grep "\[$pid\]" | awk '{sum += $5}END{print sum}'
   0 
```

总计抓取的时间为 10s，has-slave 与 no-slave 统计出来 `run time` 的时间基本相等，且`wait time` 时间极短，说明进程 `off-cpu` 的时间占比很低。

需要说明的是使用 `perf sched record` 去记录时最好不要指定 pid，直接抓取全局的调度记录，这样才能准确的分析调度的状况。 perf 是基于采样的，难以抓取到所有的 sched 事件，统计结果会存在一定误差。

综上可以得出**结论2**：在 has-slave 和 no-slave 场景下，**off-cpu的时间占比很低**（has-slave 下 off-cpu占比 0.15 %，on-slave 下 off-cpu 占比 0.14%），两者基本相同。

统计结果并未像作者预先设想那样，会由于大量的 network io 交互导致很高的 off-cpu 占比。大部分换出 cpu 是因为多任务争用(retint_careful、sysret_careful)，少部分是因为 network(inet_sendmsg)、file io 读写(xfs_file_aio_write)导致，以及缺页中断(page_fault)和内存分配(sk_stream_alloc_skb)。

### function trace

上面通过 perf profile 和 perf sched 针对 on-cpu 和 off-cpu 两方面进行了分析。而真正的每个 function 的耗时统计，以及读写 slave 带来的时间开销统计，则需要 function trace 来完成。

systemtap 是一款内核调试的利器，详情请参见[延伸阅读](#延伸阅读)，可以通过它抓取 slave 与 master 建立的 socket fd，统计所有 rw 操作耗时。抓取 slave-master 的 socket fd 的脚本如下：

``` stap
#!/usr/bin/env stap
fuction addr_parse : string (fd : long) % {
    struct sockaddr_storage stPeer;
    char buff[128];
    struct sockaddr* sin4 = NULL;
    int err = 0;
    int addrLen = 0;
    struct socket* sock = NULL;

    sock = sockfd_lookup((int)STAP_ARG_fd, &err);
    if (err != 0){
        sprintf(buff, "lookup [%d] failure: %x", (int)STAP_ARG_fd, err);
    }else{
        err = kernel_getpeername(sock, (struct sockaddr *)&stPeer, &addrLen); 
        if (err < 0) {
            sprintf(buff, "getpeername [%d] failure: %x", (int)STAP_ARG_fd, err);
        } else {
            sin4 = (struct sockaddr *)&stPeer;
            switch(sin4->sa_family){
            case AF_INET6:
                        sprintf(buff, "%pISpc", sin4);
                break;
            case AF_INET:
                        sprintf(buff, "%pISpc", sin4);
                break;
            }
        }
    }

    strlcat (STAP_RETVALUE, buff, MAXSTRINGLEN);
%}

probe syscall.accept*.return {
    if(pid()==target() && retval > 0){
        printf("accept %d: %s\n", retval, addr_parse(retval))
    }
}
```

统计 slave 相关操作耗时的脚本如下：

``` stap
#!/usr/bin/env stap
global process_event, before_sleep, call, slave_feed, slave_rw, all_rw, start
global ss = $slave_fd

probe process($redis_exec_path).function("call").return {
    if (pid()==target()) {
        delay = gettimeofday_us() - @entry(gettimeofday_us())
        call += delay
    }
}

probe process($redis_exec_path).function("replicationFeedSlaves").return {
    if (pid()==target()) {
        delay = gettimeofday_us() - @entry(gettimeofday_us())
        slave_feed += delay
    }
}

probe process($redis_exec_path).function("beforeSleep").return {
    if (pid()==target()) {
        delay = gettimeofday_us() - @entry(gettimeofday_us())
        before_sleep += delay
    }
}

probe process($redis_exec_path).function("aeProcessEvents").return {
    if (pid()==target()) {
        delay = gettimeofday_us() - @entry(gettimeofday_us())
        process_event += delay
    }
}

probe syscall.read.return {
   if (pid()==target()) {
        delay = gettimeofday_us() - @entry(gettimeofday_us())
        if(@entry($fd)==ss){
            slave_rw += delay
        }
        all_rw += delay
   } 
}

probe syscall.write.return {
   if (pid()==target()) {
        delay = gettimeofday_us() - @entry(gettimeofday_us())
        if(@entry($fd)==ss){
            slave_rw += delay
        }
        all_rw += delay
   } 
}

probe begin{
    start = gettimeofday_us() 
}

probe end{
    dur = gettimeofday_us() - start
    printf("total: %d, processEvent %d, before %d, call %d, slave_feed %d, all_rw %d, slave_rw %d\n", dur, process_event, before_sleep, call, slave_feed, all_rw, slave_rw); 
}
```

将 `$slave_fd` 和 `$redis_exec_path` 替换为实际值，运行统计的结果如下：

``` shell
    total: 10254152, processEvent 9407135, before 494402, call 6638171, slave_feed 2600933,  all_rw 933086, slave_rw 118100
```

其中 `processEvent+before = job_time = 9901537 us` 相当于整个实例处理命令的耗时，而且这里面包括 on-cpu 和 off-cpu 两个部分，`slave_feed/job_time = 26.26%` 与 上文中 `cpu 24.5%` 占比接近，`all_rw` 用于统计所有 sycall.write 和 syscall.read 的耗时，`all_rw/job_time = 9.4%` 与上文中的 cpu 采样 `16.53%` 有较大出入（这可能是由于 systemtap 引入的延迟导致，call 函数调用的次数高于 syscall，引入的延迟多于 syscall）。

slave_rw 是用于统计 slave 交互导致的耗时，`slave_rw/all_rw = 12.66% slave_rw/job_time = %1.19`， 按照比例推算，在 has-slave 场景中 slave 网络交互引入的 cpu 消耗为 `16.53%*12.66% = 2.06%`，slave 总计引入的 cpu 消耗为 `26.56%`，与上述测试的 tps 下降比例基本吻合。

### 结论

结合1、2 两个结论，最终可以汇总如下：

1. 在开启 pipeline 情况下，has-slave 相比 no-slave 下降的根因为向 slave 同步数据；

2. slave 数据同步大部由于向 slave 的发送缓冲区复制 set 命令（占 cpu 消耗 24.5%），少部分是由于 slave 网络交互（占 cpu 消耗 2.06% 推测值）。

3. 在本文 benchmark 的过程测试中，redis server 无论是否开启 slave，其大部分时间是 on-cpu 的，只有小部分时间是 off-cpu(0.14%~0.15%)，且 off-cpu 多因为系统多任务任务抢占。

由于 systemtap 的安装和入门有些门槛，可以通过 `perf trace` 进行 syscall 的耗时统计。
开启 slave 结果如下：

``` shell
    perf tarce -s -p $redis_server_pid -- sleep 10

    redis-server (289648), 275228 events, 100.0%
    syscall       calls   total       min     avg      max   stddev
                          (msec)    (msec)   (msec)  (msec)  (msec)
    ------------ ------ --------- --------- ------  ------  ------
    write         82497  1180.648    0.002   0.014   2.726   2.36%
    read          54612   626.546    0.002   0.011   0.138   0.16%
    epoll_wait      156    41.277    0.208   0.265   0.375   0.86%
    ... ...
```

不开启 slave 结果如下：

``` shell
    perf tarce -s -p $redis_server_pid -- sleep 10

    redis-server (289648), 303806 events, 100.0%
    syscall       calls   total       min     avg      max   stddev
                          (msec)    (msec)   (msec)  (msec)  (msec)
    ------------ ------ --------- --------- ------  ------  ------
    write         75673  1323.961    0.007   0.017   2.681   2.27%
    read          75644   886.095    0.002   0.012   0.299   0.17%
    epoll_wait      237    48.619    0.158   0.205   0.519   1.09%
    ... ...
```

可以明显看出开启 slave 之后，read 调用次数降低了 27.8%，write 调用次数上涨了 9.0%，read 下降的幅度接近于 tps 的降幅。

## 延伸阅读

### redis 的消息接收与发送

`redis-benchmark` 和 `redis server`中的消息处理体系，其读写过程如下：

+ receive:  内核从 NIC 中接收到消息，触发了 `readable` 事件，server 响应 `readable` 事件，调用 `read(2)`函数，将数据从内核空间复制到用户空间；
+ send: 调用 `write(2)` 函数发送消息，将数据从用户空间复制到内核空间，然后再传递到 NIC 进行发送。如果一次未完全发送，则为 `socket` 绑定 `writeHandle` 去响应 `writeable` 事件，继续发送剩余数据；

ps: redis 在 linux 中使用 `epoll(7)` 函数实现事件服务模型，其使用的事件类型为 `边沿触发`(edge-triggered) [^2]。

在调用 [createClient]() 创建 client 时，为 socket 设置了 `O_NONBLOCK` 和 `TCP_NODELAY` 两个 flag，即 socket 为非阻塞且关闭 *Nagle* 算法（主要优化small packet 的处理，提高网络利用率）提高请求的响应速度。

### redis 命令的耗时统计

redis 的命令耗时统计继承了它一贯简单易懂的风格，它为每一种 `command` 创建了一个全局对象，同种 `command` 请求都会复用这个全局对象，在 `command` 结构体内有 `microseconds` 和 `calls` 两个字段用于耗时统计：

``` C
    struct redisCommand {
        char *name;
        redisCommandProc *proc;
        int arity;
        char *sflags; /* Flags as string representation, one char per flag. */
        int flags;    /* The actual flags, obtained from the 'sflags' field. */
        /* Use a function to determine keys arguments in a command line.
        * Used for Redis Cluster redirect. */
        redisGetKeysProc *getkeys_proc;
        /* What keys should be loaded in background when calling this command? */
        int firstkey; /* The first argument that's a key (0 = no keys) */
        int lastkey;  /* The last argument that's a key */
        int keystep;  /* The step between first and last key */
        /* 用于耗时统计的字段
           microseconds 记录执行该命令的总耗时 
           calls 记录该命令的总调用次数 
        */
        long long microseconds, calls; 
    };

    /* If this function gets called we already read a whole
    * command, arguments are in the client argv/argc fields.
    * processCommand() execute the command or prepare the
    * server for a bulk read from the client.
    *
    * If C_OK is returned the client is still alive and valid and
    * other operations can be performed by the caller. Otherwise
    * if C_ERR is returned the client was destroyed (i.e. after QUIT). */
    int processCommand(client *c) {
        /* Now lookup the command and check ASAP about trivial error conditions
        * such as wrong arity, bad command name and so forth. */
        // 从command列表中找到要执行的command，
        // 同时赋值给 c->cmd 和 c->lastcmd.
        // lookupCommand 函数会返回待执行命令对应的全局对象 
        c->cmd = c->lastcmd = lookupCommand(c->argv[0]->ptr);

        /* Exec the command */
        if (c->flags & CLIENT_MULTI &&
            c->cmd->proc != execCommand && c->cmd->proc != discardCommand &&
            c->cmd->proc != multiCommand && c->cmd->proc != watchCommand)
        {
            queueMultiCommand(c);
            addReply(c,shared.queued);
        } else {
            call(c,CMD_CALL_FULL);
            c->woff = server.master_repl_offset;
            if (listLength(server.ready_keys))
                handleClientsBlockedOnLists();
        }
        return C_OK;
    }

    void call(client *c, int flags) {
        ... ...
        /* Call the command. */
        dirty = server.dirty;
        // 记录起始时间，使用 us 时间戳
        start = ustime();
        c->cmd->proc(c);
        // 计算耗时
        duration = ustime()-start;
        dirty = server.dirty-dirty;
        if (dirty < 0) dirty = 0;
        ... ...
        ... ...
        if (flags & CMD_CALL_STATS) {
            // 更新总耗时
            c->lastcmd->microseconds += duration;
            // 更新总执行数量
            c->lastcmd->calls++;
        }
    }
```

需要额外补充的是，redis 在`multi-exec` 执行过程中会将所有包含的指令统计为 `execCommand`:

``` C
    void execCommand(client *c) {
        ... ...
        // 依次执行所有缓存的`mult-exec`指令
        for (j = 0; j < c->mstate.count; j++) {
            c->argc = c->mstate.commands[j].argc;
            c->argv = c->mstate.commands[j].argv;
            c->cmd = c->mstate.commands[j].cmd;

            /* Propagate a MULTI request once we encounter the first command which
            * is not readonly nor an administrative one.
            * This way we'll deliver the MULTI/..../EXEC block as a whole and
            * both the AOF and the replication link will have the same consistency
            * and atomicity guarantees. */
            if (!must_propagate && !(c->cmd->flags & (CMD_READONLY|CMD_ADMIN))) {
                execCommandPropagateMulti(c);
                must_propagate = 1;
            }

            // 调用执行对应的命令
            call(c,server.loading ? CMD_CALL_NONE : CMD_CALL_FULL);

            /* Commands may alter argc/argv, restore mstate. */
            c->mstate.commands[j].argc = c->argc;
            c->mstate.commands[j].argv = c->argv;
            c->mstate.commands[j].cmd = c->cmd;
        }
        ... ...
    }
```

结合 `processCommand` 函数的代码，在执行 `exec`请求时已经赋值 `c->lastcmd=execCommand`，在调用`call` 函数执行 `execCommand` 时会在结束后累计一个执行次数，而在 `execCommand` 内部调用 `call` 也会累计 N （mulit-exec打包的命令个数）个执行次数，而这些执行都会累计到 `c->lastcmd` 即 `exec` 上，即会累计 `N+1` 个 `execCommand`调用次数:

``` mermaid! 
flowchart TB
    start([start])
    exit([end])

    process[proccessCommand: <br> c->lastcmd=execCommand]
    multi[proccessCommand:call:<br>execCommand start]
    next{proccessCommand:call:<br>execCommand:<br>next command?}
    run[proccessCommand:call:<br>execCommand:call:<br> run xx command, c->lastcmd->calls++]
    return[proccessCommand:call:<br>execCommand end, c->lastcmd->calls++]

    start-->process-->multi-->next
    next-->|No|return-->exit
    next-->|Yes|run-->next
```

### perf sched

perf sched timehist 示例如下：

``` shell
    perf sched record -- sleep 1
    perf sched timehist

            time    cpu    task name             wait time  sch delay   run time
                           [tid/pid]              (msec)     (msec)     (msec)
    -------------- ------  --------------------  ---------  ---------  ---------
    79371.874569 [0011]  gcc[31949]                0.014      0.000      1.148
    79371.874591 [0010]  gcc[31951]                0.000      0.000      0.024
    79371.874603 [0010]  migration/10[59]          3.350      0.004      0.011
    79371.874604 [0011]  <idle>                    1.148      0.000      0.035
    79371.874723 [0005]  <idle>                    0.016      0.000      1.383
    79371.874746 [0005]  gcc[31949]                0.153      0.078      0.022           
```

输出项说明：

+ wait time：在 sched-out 和 下一个 sched-in 之间的间隔；
+ sch delay：在 wakeup 时间 和 实际 running 之间的间隔；
+ run time：task 实际处于 running 的时间；

可以通过 `perf list | grep sched` 查看系统中所有的 tracepoint，核心的 tracepoint 为：

+ sched_switch：记录 cpu 上 task 切换的事件，从 prev 切换到 next；
+ sched_wakeup：记录唤醒 task 的时间，记录唤醒 p 和 current；
+ sched_waking：3.10 中不支持此 tracepoint；
+ sched_migrate_task：记录 task 迁移到目的 cpu 事件，p 切换到 dest_cpu；

除此外还有 state 类型，用于统计 delay 时间：

+ sched_stat_blocked：任务不可中断时间；
+ sched_stat_iowait：由于等待 IO 完成，任务不可运行的时间；
+ sched_stat_runtime：记录在 cpu 上执行的时间；
+ sched_stat_sleep：任务不可运行的时间，包括 io_wait；
+ sched_stat_wait：由于调度程序争，任务可执行而未执行的延迟时间；

上述的 timehist 即是通过 state 进行统计：

+ t = time of current schedule out event
+ tprev = time of previous sched out event also time of schedule-in event for current task
+ last_time = time of last sched change event for current task(i.e, time process was last scheduled out)
+ ready_to_run = time of wakeup for current task
 
```
  -----|------------|------------|------------|------
      last         ready        tprev         t
      time         to run
       |-------- wait time ------|
                   |- sch delay -|- run time -|
```

### stap 使用

stap -L "syscall.*" 可以查看当前操作系统支持探测的 event，和 event 中携带的参数：

``` shell
stap -L "syscall.*" 
... ...
syscall.read name:string fd:long buf_uaddr:long count:long argstr:string
... ...
syscall.write name:string fd:long buf_uaddr:long count:long buf_str:string argstr:string
... ...
```

使用 stap 命令进行编译运行时会经过如下步骤[^7]：

1. 首先，SystemTap 根据现有的 Tapset 库（通常在 /usr/share/systemtap/tapset/ 中) 检查使用的任何 Tapset。SystemTap 将用它们在 Tapset 库中的相应定义替换任何找到的 Tapset;

2. SystemTap 然后将脚本转换为 C，运行系统 C 编译器以从中创建内核模块。执行此步骤的工具包含在 systemtap 包中（有关详细信息，请参阅第 2.1.1 节“安装 SystemTap”）;

3. SystemTap 加载模块，然后启用脚本中的所有探测器（事件和处理程序）。 systemtap-runtime 包中的 staprun（有关更多信息，请参阅第 2.1.1 节“安装 SystemTap”）提供此功能。

4. 随着事件的发生，它们相应的处理程序被执行。

5. 一旦 SystemTap 会话终止，探测器将被禁用，内核模块将被卸载。

编译和运行命令如下：

``` shell
# CONFIG_MODVERSIONS 指定内核检查时根据 symbol，跳过 magic 检查；
# -p4 指定stap 只执行到第 4 步即输出内核模块 xx.ko, 第 5 步为安装执行。 
sudo stap -vv -B CONFIG_MODVERSIONS=y -p4 -g xx.stp -m xx

# 指定 pid
sudo staprun xx.ko -x $pid

# 指定执行的命令，并监听 可以直接在 stap 脚本中通过 target() 获取 pid.
sudo staprun xx.ko -c $command 
```

## 参考引用

[^1]: redis_psync_protocol(1). Zhipeng Wang. Jan 06 2022, https://saffraan.github.io/redis_psync_protocol(1)/#%E5%91%BD%E4%BB%A4%E5%90%8C%E6%AD%A5
[^2]: man epoll(7). linux. Sep 15 2017, https://man7.org/linux/man-pages/man7/epoll.7.html

[^3]: perf sched.. https://zhuanlan.zhihu.com/p/143320517
[^4]: off-cpu. . https://www.brendangregg.com/offcpuanalysis.html
[^5]: Linux中如何保证数据安全落盘. 黑客画家. Jun 14 2019, https://my.oschina.net/fileoptions/blog/3061997
[^6]: Direct I/O tuning. IBM. Apr 07 2022, https://www.ibm.com/docs/en/aix/7.2?topic=tuning-direct-io
[^7]: SystemTap Beginners Guide. sourceware.org. May 09 2022, https://sourceware.org/systemtap/SystemTap_Beginners_Guide/understanding-how-systemtap-works.html#understanding-architecture-tools
