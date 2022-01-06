---
layout: single
toc: true
classes: wide
---
<style>
    p { font: 0.875rem YaHei !important; }
</style>

# Redis psync protocol(续)

在上一篇 [redis psync protocol](https://saffraan.github.io/redis_psync_protocol/) 中详细的阐述了 psync 协议的交互流程和实现细节，本文主要是针对命令同步的细节和生产实践中遇到的场景进行一些补充。文中代码部分可以忽略，直接看相关结论。

## 命令同步

在 redis 的源码中包含多种 command flag，利用这些 flag 来标识 command 的属性：

+ r(读)：读取数据，不会修改 key 数据；
+ w(写)：写入数据，可能会修改 key 数据；
+ m(内存)：可能会增长内存使用率，在 out of memory 时不允许使用；
+ a(管理)：管理命令，例如 SHUTDOWN、SAVE 命令；
+ p(发布订阅)：发布订阅相关的命令；
+ f(强制同步)：无论是否修改 data set 都需要同步给 slave；
+ s(非script)：在script中不支持的命令；
+ l(loading)：在数据库加载数据时允许执行的命令；
+ t(-)：当 slave 具有一些陈旧数据但是不允许使用该数据提供服务时，只有少数命令被允许执行；
+ M(屏蔽monitor)：不会被自动传播给 monitor 的命令；
+ k(ask)： 为此命令执行隐式 ASKING，因此如果 slot 标记为“importing”，则该命令将在集群模式下被接受；
+ F(Fast command)：在 kernel 分配足够执行时间时，时间复杂度为 O(1)、O(log(N)) 的命令执行很快，几乎无延迟。需要注意的是可能会触发 “DEL” 的命令不是 Fast command（例如 SET）；

每一个命令可能会包含多个 flag，例如 `get` 命令的 command flag 为 `rF`，表示该命令是一个只读的 fast command。对于主从同步来说**不会修改 data set 的命令是无需同步的（例如：带有 `r` flag 的命令），可能会修改 data set 的命令也只需要在实际修改了 data set 时才去同步**。带有 `f` flag 的命令则无论是否修改 data set 都需要被同步，但目前在 5.0 版本中未发现携带该 flag 的命令。

执行命令时调用的是[processCommand](https://github.com/redis/redis/blob/5.0/src/server.c#L2585)函数：

``` C
/* If this function gets called we already read a whole
 * command, arguments are in the client argv/argc fields.
 * processCommand() execute the command or prepare the
 * server for a bulk read from the client.
 *
 * If C_OK is returned the client is still alive and valid and
 * other operations can be performed by the caller. Otherwise
 * if C_ERR is returned the client was destroyed (i.e. after QUIT). */
int processCommand(client *c) {
    ... ...
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
            handleClientsBlockedOnKeys();
    }
}
```

在 processCommand 执行 command 前要经过一系列的检查：

1. 检查命令是否合法，如果命令不合法会将 transaction 标记为失败
2. 检查 client 认证信息
3. 如果开启了 cluster 检查是否需要重定向（master节点的无需重定向）
4. 检查内存是否充足
5. 如果当前节点为主节点，且存在磁盘持久化的问题，则拒绝写入命令
6. 如果配置了 min-slaves-to-write 选项，且当前slaves数量不满足，则拒绝写入命令
7. 当 slave-serve-stale-data 选项为 no，且节点为slave 且未与 master建立链接时，仅接受 INFO、SLAVEOF、PING、AUTH、replconf、replicaof、role、config、 等 flag 为 ‘t’ 的命令
8. 如果 server 处于 loading 状态，当前command 不包含 CMD_LOADING flag 则返回 loadingerr
9. 如果当前server处于 lua 超时状态，则只接受 auth、replconf、shutdown nosave、script kill命令
10. 执行命令，如果是 multibulk命令，则加入到 args 中等 exec 命令，否则调用 call 执行

在执行命令时主要是调用 [call](https://github.com/redis/redis/blob/5.0/src/server.c#L2451) 函数，在 redis 执行命令时不仅要同步给 slave 节点，（当aof日志开启时）也需要同步到 aof log，call 函数可以根据传入的 flag 来判断 `propagation` 的行为：

+ CMD_CALL_PROPAGATE_AOF: 如果修改了 data set 则将命令同步到 AOF 日志；
+ CMD_CALL_PROPAGATE_REPL: 如果修改了 data set 则将命令同步给 slave 节点；

同时 client 自身的 flag 也会影响到 `propagation` 的行为，具体逻辑如下：

``` C
/* Call() is the core of Redis execution of a command.
 *
 * The following flags can be passed:
 * CMD_CALL_NONE        No flags.
 * CMD_CALL_SLOWLOG     Check command speed and log in the slow log if needed.
 * CMD_CALL_STATS       Populate command stats.
 * CMD_CALL_PROPAGATE_AOF   Append command to AOF if it modified the dataset
 *                          or if the client flags are forcing propagation.
 * CMD_CALL_PROPAGATE_REPL  Send command to salves if it modified the dataset
 *                          or if the client flags are forcing propagation.
 * CMD_CALL_PROPAGATE   Alias for PROPAGATE_AOF|PROPAGATE_REPL.
 * CMD_CALL_FULL        Alias for SLOWLOG|STATS|PROPAGATE.
 *
 * The exact propagation behavior depends on the client flags.
 * Specifically:
 *
 * 1. If the client flags CLIENT_FORCE_AOF or CLIENT_FORCE_REPL are set
 *    and assuming the corresponding CMD_CALL_PROPAGATE_AOF/REPL is set
 *    in the call flags, then the command is propagated even if the
 *    dataset was not affected by the command.
 * 2. If the client flags CLIENT_PREVENT_REPL_PROP or CLIENT_PREVENT_AOF_PROP
 *    are set, the propagation into AOF or to slaves is not performed even
 *    if the command modified the dataset.
 *
 * Note that regardless of the client flags, if CMD_CALL_PROPAGATE_AOF
 * or CMD_CALL_PROPAGATE_REPL are not set, then respectively AOF or
 * slaves propagation will never occur.
 *
 * Client flags are modified by the implementation of a given command
 * using the following API:
 *
 * forceCommandPropagation(client *c, int flags);
 * preventCommandPropagation(client *c);
 * preventCommandAOF(client *c);
 * preventCommandReplication(client *c);
 *
 */
void call(client *c, int flags) {
     /* Propagate the command into the AOF and replication link */
    if (flags & CMD_CALL_PROPAGATE &&
        (c->flags & CLIENT_PREVENT_PROP) != CLIENT_PREVENT_PROP)
    {
        int propagate_flags = PROPAGATE_NONE;

        /* Check if the command operated changes in the data set. If so
         * set for replication / AOF propagation. */
        if (dirty) propagate_flags |= (PROPAGATE_AOF|PROPAGATE_REPL);

        /* If the client forced AOF / replication of the command, set
         * the flags regardless of the command effects on the data set. */
        if (c->flags & CLIENT_FORCE_REPL) propagate_flags |= PROPAGATE_REPL;
        if (c->flags & CLIENT_FORCE_AOF) propagate_flags |= PROPAGATE_AOF;

        /* However prevent AOF / replication propagation if the command
         * implementations called preventCommandPropagation() or similar,
         * or if we don't have the call() flags to do so. */
        if (c->flags & CLIENT_PREVENT_REPL_PROP ||
            !(flags & CMD_CALL_PROPAGATE_REPL))
                propagate_flags &= ~PROPAGATE_REPL;
        if (c->flags & CLIENT_PREVENT_AOF_PROP ||
            !(flags & CMD_CALL_PROPAGATE_AOF))
                propagate_flags &= ~PROPAGATE_AOF;

        /* Call propagate() only if at least one of AOF / replication
         * propagation is needed. Note that modules commands handle replication
         * in an explicit way, so we never replicate them automatically. */
        if (propagate_flags != PROPAGATE_NONE && !(c->cmd->flags & CMD_MODULE))
            propagate(c->cmd,c->db->id,c->argv,c->argc,propagate_flags);
    }
    ... ...
}
```

综上，如果要想将命令写入 aof 和 slave 则必须要满足两个条件：

1. 传入 `CMD_CALL_PROPAGATE_AOF|CMD_CALL_PROPAGATE_REPL` flag；
2. 命令修改了 data set；

processCommand 调用 call 函数传入的 flag 为 `CMD_CALL_FULL`，相当于  `SLOWLOG|STATS|PROPAGATE`，所以条件 1 是满足。条件 2 的关键在于如何判断 data set 是否被修改了？这主要依赖于 server.dirty 字段，**如果命令在执行的过程中有修改 data set 的操作，server.dirty 字段会被修改**。其核心逻辑实现也在 call 函数中：

``` C
void call(client *c, int flags) {
    ... ...
    /* Call the command. */
    dirty = server.dirty;
    updateCachedTime(0);
    start = server.ustime;
    c->cmd->proc(c);
    duration = ustime()-start;
    dirty = server.dirty-dirty;
    if (dirty < 0) dirty = 0;
    
    ... ...

     /* Propagate the command into the AOF and replication link */
    if (flags & CMD_CALL_PROPAGATE &&
        (c->flags & CLIENT_PREVENT_PROP) != CLIENT_PREVENT_PROP)
    {
        int propagate_flags = PROPAGATE_NONE;

        /* Check if the command operated changes in the data set. If so
         * set for replication / AOF propagation. */
        if (dirty) propagate_flags |= (PROPAGATE_AOF|PROPAGATE_REPL);
        
        ... ...

        /* Call propagate() only if at least one of AOF / replication
         * propagation is needed. Note that modules commands handle replication
         * in an explicit way, so we never replicate them automatically. */
        if (propagate_flags != PROPAGATE_NONE && !(c->cmd->flags & CMD_MODULE))
            propagate(c->cmd,c->db->id,c->argv,c->argc,propagate_flags);
    }
}

/* Propagate the specified command (in the context of the specified database id)
 * to AOF and Slaves.
 *
 * flags are an xor between:
 * + PROPAGATE_NONE (no propagation of command at all)
 * + PROPAGATE_AOF (propagate into the AOF file if is enabled)
 * + PROPAGATE_REPL (propagate into the replication link)
 *
 * This should not be used inside commands implementation since it will not
 * wrap the resulting commands in MULTI/EXEC. Use instead alsoPropagate(),
 * preventCommandPropagation(), forceCommandPropagation().
 *
 * However for functions that need to (also) propagate out of the context of a
 * command execution, for example when serving a blocked client, you
 * want to use propagate().
 */
void propagate(struct redisCommand *cmd, int dbid, robj **argv, int argc,
               int flags)
{
    if (server.aof_state != AOF_OFF && flags & PROPAGATE_AOF)
        feedAppendOnlyFile(cmd,dbid,argv,argc);
    if (flags & PROPAGATE_REPL)
        replicationFeedSlaves(server.slaves,dbid,argv,argc);
}
```

综上，扩散命令到 slave 节点的调用链为：processCommand->call->propagate->replicationFeedSlaves，针对 replicationFeedSlaves 的解析在下文会提到。下面以 [set](https://github.com/redis/redis/blob/5.0/src/t_string.c#L96) 命令为例展示一下 server.dirty 的作用：

``` C
/* SET key value [NX] [XX] [EX <seconds>] [PX <milliseconds>] */
void setCommand(client *c) {
    /* parse args */
    ... ...
    setGenericCommand(c,flags,c->argv[1],c->argv[2],expire,unit,NULL,NULL);
}

void setGenericCommand(client *c, int flags, robj *key, robj *val, robj *expire, int unit, robj *ok_reply, robj *abort_reply) {
    long long milliseconds = 0; /* initialized to avoid any harmness warning */

    if (expire) {
        if (getLongLongFromObjectOrReply(c, expire, &milliseconds, NULL) != C_OK)
            return;
        if (milliseconds <= 0) {
            addReplyErrorFormat(c,"invalid expire time in %s",c->cmd->name);
            return;
        }
        if (unit == UNIT_SECONDS) milliseconds *= 1000;
    }

    if ((flags & OBJ_SET_NX && lookupKeyWrite(c->db,key) != NULL) ||
        (flags & OBJ_SET_XX && lookupKeyWrite(c->db,key) == NULL))
    {
        addReply(c, abort_reply ? abort_reply : shared.nullbulk);
        return;
    }
    setKey(c->db,key,val);
    server.dirty++;
    if (expire) setExpire(c,c->db,key,mstime()+milliseconds);
    notifyKeyspaceEvent(NOTIFY_STRING,"set",key,c->db->id);
    if (expire) notifyKeyspaceEvent(NOTIFY_GENERIC,
        "expire",key,c->db->id);
    addReply(c, ok_reply ? ok_reply : shared.ok);
}
```

在经过 expire time 和 NX/XX 的判断后，就会去修改内存中的数据，此时执行 `server.dirty++`，则会被同步到 slaves 和 aof，由此可见即使向 key 中写入同样的 value 也会被同步。

## 同步转化

在 redis 中大部分命令都会原封不动的转发给 slave 节点，也存在少部分命令需要会转化为其他命令再同步给 slave 节点。

1. eval 和 evalsha
    在 redis lua script 中支持很多内生函数，其中与复制相关的如下：

    + redis.replicate_commands()：启动脚本效果复制，开启后只复制脚本生成的写入命令，无需复制整个脚本。需要在监本执行任何操作之前调用，在 Redis 5.0 中默认开启。
    + redis.set_repl(int flag)：在开启脚本效果复制后，使用 flag 其控制复制行为：REPL_NONE、REPL_AOF、REPL_SLAVE、REPL_RELICA、REPL_ALL（缺省复制行为）。与上文中 call 函数中 flag 功能十分相似。

    所以在 5.0 中执行 script 会被自动转换为 multi-exec 事务命令；在 >= 4.0.4 版本中 evalsha 命令会被转化为 eval；在 < 4.0.4 版本中则不会转化，直接转发。

2. migrate
    slot 迁移属于数据库管理指令，在执行槽迁移时，会在源节点执行 `DUMP + DEL` 命令，在目的节点执行 `RESTOR` 命令。由于 `DUMP` 命令未修改 data set 所以不会被同步给 slave 节点， `DEL` 和 `RESTOR`命令会同步给 slave 节点。

## 增量同步数据传输和错误处理

master 发送数据时调用 [replicationFeedSlaves](https://github.com/redis/redis/blob/5.0/src/replication.c#L174) 函数会调用 [addReplyBulk](https://github.com/redis/redis/blob/5.0/src/networking.c#L562) 将 backlog 中缓存的数据加入到 slave list 中每个 slave client 的发送缓冲区。其中 addReplyBulk 的核心函数 [addReply](https://github.com/redis/redis/blob/5.0/src/networking.c#L536)  会调用 [prepareClientToWrite](https://github.com/redis/redis/blob/5.0/src/networking.c#L212) 会将 client 加入到 `server.clients_pending_write` 队列中，redis 主进程在每次进入 event loop 前调用 [handleClientsWithPendingWrites](https://github.com/redis/redis/blob/5.0/src/networking.c#L1082) 将 client 从 `server.clients_pending_write` 队列中取出，将 client buffer 中的数据发送对端：

``` C
/* Propagate write commands to slaves, and populate the replication backlog
 * as well. This function is used if the instance is a master: we use
 * the commands received by our clients in order to create the replication
 * stream. Instead if the instance is a slave and has sub-slaves attached,
 * we use replicationFeedSlavesFromMaster() */
void replicationFeedSlaves(list *slaves, int dictid, robj **argv, int argc) {
    
    /* Write the command to backlog. */
    ... ...

    /* Write the command to every slave. */
    listRewind(slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        /* Don't feed slaves that are still waiting for BGSAVE to start */
        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) continue;

        /* Feed slaves that are waiting for the initial SYNC (so these commands
         * are queued in the output buffer until the initial SYNC completes),
         * or are already in sync with the master. */

        /* Add the multi bulk length. */
        addReplyMultiBulkLen(slave,argc);

        /* Finally any additional argument that was not stored inside the
         * static buffer if any (from j to argc). */
        for (j = 0; j < argc; j++)
            addReplyBulk(slave,argv[j]);
    }
}

/* -----------------------------------------------------------------------------
 * Higher level functions to queue data on the client output buffer.
 * The following functions are the ones that commands implementations will call.
 * -------------------------------------------------------------------------- */

/* Add the object 'obj' string representation to the client output buffer. */
void addReply(client *c, robj *obj) {
    if (prepareClientToWrite(c) != C_OK) return;

    /* add the object into the client buffer*/
    ... ... 
}

/* This function is called every time we are going to transmit new data
 * to the client. The behavior is the following:
 *
 * If the client should receive new data (normal clients will) the function
 * returns C_OK, and make sure to install the write handler in our event
 * loop so that when the socket is writable new data gets written.
 *
 * If the client should not receive new data, because it is a fake client
 * (used to load AOF in memory), a master or because the setup of the write
 * handler failed, the function returns C_ERR.
 *
 * The function may return C_OK without actually installing the write
 * event handler in the following cases:
 *
 * 1) The event handler should already be installed since the output buffer
 *    already contains something.
 * 2) The client is a slave but not yet online, so we want to just accumulate
 *    writes in the buffer but not actually sending them yet.
 *
 * Typically gets called every time a reply is built, before adding more
 * data to the clients output buffers. If the function returns C_ERR no
 * data should be appended to the output buffers. */
int prepareClientToWrite(client *c) {
   ... ...

    /* Schedule the client to write the output buffers to the socket, unless
     * it should already be setup to do so (it has already pending data). */
    if (!clientHasPendingReplies(c)) clientInstallWriteHandler(c);

    /* Authorize the caller to queue in the output buffer of this client. */
    return C_OK;
}

/* This funciton puts the client in the queue of clients that should write
 * their output buffers to the socket. Note that it does not *yet* install
 * the write handler, to start clients are put in a queue of clients that need
 * to write, so we try to do that before returning in the event loop (see the
 * handleClientsWithPendingWrites() function).
 * If we fail and there is more data to write, compared to what the socket
 * buffers can hold, then we'll really install the handler. */
void clientInstallWriteHandler(client *c) {
    /* Schedule the client to write the output buffers to the socket only
     * if not already done and, for slaves, if the slave can actually receive
     * writes at this stage. */
    if (!(c->flags & CLIENT_PENDING_WRITE) &&
        (c->replstate == REPL_STATE_NONE ||
         (c->replstate == SLAVE_STATE_ONLINE && !c->repl_put_online_on_ack)))
    {
        /* Here instead of installing the write handler, we just flag the
         * client and put it into a list of clients that have something
         * to write to the socket. This way before re-entering the event
         * loop, we can try to directly write to the client sockets avoiding
         * a system call. We'll only really install the write handler if
         * we'll not be able to write the whole reply at once. */
        c->flags |= CLIENT_PENDING_WRITE;
        listAddNodeHead(server.clients_pending_write,c);
    }
}
```

着重分析一下 handleClientsWithPendingWrites 函数，它会将 client 从队列中依次取出，尝试调用 [writeToClient](https://github.com/redis/redis/blob/5.0/src/networking.c#L979) 将数据直接发送给对端，如果仍有残留数据需要发送，绑定 [sendReplyToClient](https://github.com/redis/redis/blob/5.0/src/networking.c#L1072) 到 slave fd 的可写入事件。当接收到写入事件，调用 POSIX write 向 slave fd 写入发送缓冲区的数据，write 如果返回小于 0，则停止写入。如果`errno == EAGAIN`，则忽略错误直接返回，否则返回错误，且会主动释放掉链接：

``` C
/* This function is called just before entering the event loop, in the hope
 * we can just write the replies to the client output buffer without any
 * need to use a syscall in order to install the writable event handler,
 * get it called, and so forth. */
int handleClientsWithPendingWrites(void) {
    listIter li;
    listNode *ln;
    int processed = listLength(server.clients_pending_write);

    listRewind(server.clients_pending_write,&li);
    while((ln = listNext(&li))) {
        client *c = listNodeValue(ln);
        c->flags &= ~CLIENT_PENDING_WRITE;
        listDelNode(server.clients_pending_write,ln);

        /* If a client is protected, don't do anything,
         * that may trigger write error or recreate handler. */
        if (c->flags & CLIENT_PROTECTED) continue;

        /* Try to write buffers to the client socket. */
        if (writeToClient(c->fd,c,0) == C_ERR) continue;

        /* If after the synchronous writes above we still have data to
         * output to the client, we need to install the writable handler. */
        if (clientHasPendingReplies(c)) {
            int ae_flags = AE_WRITABLE;
            /* For the fsync=always policy, we want that a given FD is never
             * served for reading and writing in the same event loop iteration,
             * so that in the middle of receiving the query, and serving it
             * to the client, we'll call beforeSleep() that will do the
             * actual fsync of AOF to disk. AE_BARRIER ensures that. */
            if (server.aof_state == AOF_ON &&
                server.aof_fsync == AOF_FSYNC_ALWAYS)
            {
                ae_flags |= AE_BARRIER;
            }
            if (aeCreateFileEvent(server.el, c->fd, ae_flags,
                sendReplyToClient, c) == AE_ERR)
            {
                    freeClientAsync(c);
            }
        }
    }
    return processed;
}

/* Write event handler. Just send data to the client. */
void sendReplyToClient(aeEventLoop *el, int fd, void *privdata, int mask) {
    UNUSED(el);
    UNUSED(mask);
    writeToClient(fd,privdata,1);
}

/* Write data in output buffers to client. Return C_OK if the client
 * is still valid after the call, C_ERR if it was freed. */
int writeToClient(int fd, client *c, int handler_installed) {
    ... ...
    while(clientHasPendingReplies(c)) {
        ... ...
        if (nwritten == -1) {
            if (errno == EAGAIN) {
                nwritten = 0;
            } else {
                serverLog(LL_VERBOSE,
                    "Error writing to client: %s", strerror(errno));
                freeClient(c);
                return C_ERR;
            }
        }
        ... ..
    }
    return C_OK;
}

```

slave 在完成 psync shake 后会调用 [replicationResurrectCachedMaster](https://github.com/redis/redis/blob/5.0/src/replication.c#L2284) 将 [readQueryFromClient](https://github.com/redis/redis/blob/5.0/src/networking.c#L1522) 与 master fd 的读取 event 绑定。当接收到读取事件，调用 POSIX read 从 master fd 读取数据，read 如果返回小于 0，则停止读取。如果 `errno == EAGAIN`则忽略错误，否则返回错误，且主动释放掉链接：

```C
/* Turn the cached master into the current master, using the file descriptor
 * passed as argument as the socket for the new master.
 *
 * This function is called when successfully setup a partial resynchronization
 * so the stream of data that we'll receive will start from were this
 * master left. */
void replicationResurrectCachedMaster(int newfd) {
    server.master = server.cached_master;
    server.cached_master = NULL;
    server.master->fd = newfd;
    server.master->flags &= ~(CLIENT_CLOSE_AFTER_REPLY|CLIENT_CLOSE_ASAP);
    server.master->authenticated = 1;
    server.master->lastinteraction = server.unixtime;
    server.repl_state = REPL_STATE_CONNECTED;
    server.repl_down_since = 0;

    /* Re-add to the list of clients. */
    linkClient(server.master);
    if (aeCreateFileEvent(server.el, newfd, AE_READABLE,
                          readQueryFromClient, server.master)) {
        serverLog(LL_WARNING,"Error resurrecting the cached master, impossible to add the readable handler: %s", strerror(errno));
        freeClientAsync(server.master); /* Close ASAP. */
    }

    /* We may also need to install the write handler as well if there is
     * pending data in the write buffers. */
    if (clientHasPendingReplies(server.master)) {
        if (aeCreateFileEvent(server.el, newfd, AE_WRITABLE,
                          sendReplyToClient, server.master)) {
            serverLog(LL_WARNING,"Error resurrecting the cached master, impossible to add the writable handler: %s", strerror(errno));
            freeClientAsync(server.master); /* Close ASAP. */
        }
    }
}

```

readQueryFromClient 函数中调用 [processInputBufferAndReplicate](https://github.com/redis/redis/blob/5.0/src/networking.c#L1507)函数，该函数会先调用 [processInputBuffer](https://github.com/redis/redis/blob/5.0/src/networking.c#L1428) 将数据应用到内存中，再调用 [replicationFeedSlavesFromMasterStream](https://github.com/redis/redis/blob/5.0/src/replication.c#L279) 将数据刷到 sub-slaves：

``` C

void readQueryFromClient(aeEventLoop *el, int fd, void *privdata, int mask) {
   
    ... ...

    /* Time to process the buffer. If the client is a master we need to
     * compute the difference between the applied offset before and after
     * processing the buffer, to understand how much of the replication stream
     * was actually applied to the master state: this quantity, and its
     * corresponding part of the replication stream, will be propagated to
     * the sub-slaves and to the replication backlog. */
    processInputBufferAndReplicate(c);
}

/* This is a wrapper for processInputBuffer that also cares about handling
 * the replication forwarding to the sub-slaves, in case the client 'c'
 * is flagged as master. Usually you want to call this instead of the
 * raw processInputBuffer(). */
void processInputBufferAndReplicate(client *c) {
    if (!(c->flags & CLIENT_MASTER)) {
        processInputBuffer(c);
    } else {
        size_t prev_offset = c->reploff;
        processInputBuffer(c);
        size_t applied = c->reploff - prev_offset;
        if (applied) {
            replicationFeedSlavesFromMasterStream(server.slaves,
                    c->pending_querybuf, applied);
            sdsrange(c->pending_querybuf,applied,-1);
        }
    }
}

/* This function is called every time, in the client structure 'c', there is
 * more query buffer to process, because we read more data from the socket
 * or because a client was blocked and later reactivated, so there could be
 * pending query buffer, already representing a full command, to process. */
void processInputBuffer(client *c) {
   ... ...
}

/* This function is used in order to proxy what we receive from our master
 * to our sub-slaves. */
#include <ctype.h>
void replicationFeedSlavesFromMasterStream(list *slaves, char *buf, size_t buflen) {
    listNode *ln;
    listIter li;

    /* Debugging: this is handy to see the stream sent from master
     * to slaves. Disabled with if(0). */
    if (0) {
        printf("%zu:",buflen);
        for (size_t j = 0; j < buflen; j++) {
            printf("%c", isprint(buf[j]) ? buf[j] : '.');
        }
        printf("\n");
    }

    if (server.repl_backlog) feedReplicationBacklog(buf,buflen);
    listRewind(slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        /* Don't feed slaves that are still waiting for BGSAVE to start */
        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) continue;
        addReplyString(slave,buf,buflen);
    }
}
```

在 replicationFeedSlavesFromMasterStream 中的 addReplyString 函数仍然调用的是 addReply，所以在发生网络错误时采取的逻辑相同。综上，**redis 在主从同步过程中遇到问题时的处理逻辑很简单，一旦发生错误就会直接调用 [freeClient](https://github.com/redis/redis/blob/5.0/src/networking.c#L847) 函数释放掉 client 对象**。

## Slave 增量同步过慢

在主从同步的过程中，可能发生从库同步太慢，重新触发全量同步的情况。repl backlog 的机制已经在上一篇中详细介绍了，那如何判断何时该主动放弃 slave 的异步同步呢？在 redis 中一切机制都按照从简的原则，如上文所说在接收到一个需要同步的命令时，会将其添加到 slave client 的发送缓冲区，当接收到缓冲区超过配置的阈值时，会主动放弃 (调用 free client 释放) slave client。具体实现在 [asyncCloseClientOnOutputBufferLimitReached](https://github.com/redis/redis/blob/5.0/src/networking.c#L2128) 函数，如下：

``` C
/* -----------------------------------------------------------------------------
 * Higher level functions to queue data on the client output buffer.
 * The following functions are the ones that commands implementations will call.
 * -------------------------------------------------------------------------- */

/* Add the object 'obj' string representation to the client output buffer. */
void addReply(client *c, robj *obj){
    ... ...
}

/* The function checks if the client reached output buffer soft or hard
 * limit, and also update the state needed to check the soft limit as
 * a side effect.
 *
 * Return value: non-zero if the client reached the soft or the hard limit.
 *               Otherwise zero is returned. */
int checkClientOutputBufferLimits(client *c) {   
}

/* Asynchronously close a client if soft or hard limit is reached on the
 * output buffer size. The caller can check if the client will be closed
 * checking if the client CLIENT_CLOSE_ASAP flag is set.
 *
 * Note: we need to close the client asynchronously because this function is
 * called from contexts where the client can't be freed safely, i.e. from the
 * lower level functions pushing data inside the client output buffers. */
void asyncCloseClientOnOutputBufferLimitReached(client *c) {
    if (c->fd == -1) return; /* It is unsafe to free fake clients. */
    serverAssert(c->reply_bytes < SIZE_MAX-(1024*64));
    if (c->reply_bytes == 0 || c->flags & CLIENT_CLOSE_ASAP) return;
    if (checkClientOutputBufferLimits(c)) {
        sds client = catClientInfoString(sdsempty(),c);

        freeClientAsync(c);
        serverLog(LL_WARNING,"Client %s scheduled to be closed ASAP for overcoming of output buffer limits.", client);
        sdsfree(client);
    }
}
```

## FullResync 过程中 RDB 的生成和传输

本节先提出以下问题，下文会依次解答：

1. 什么情况下会触发 bgSave?
    PSYNC/SYNC command，replicationCron/serverCron，BgSave/BgRewrite command，RDB 或 aof-preamble 日志。
2. RDB 数据是如何生成的？
    首先 Fork 子进程去执行 bgSave 任务，然后根据不同场景决定文件头部的格式，将内存中的数据序列化后写入文件。
3. diskless 和 rdb file 两种模式有什么区别？
    diskless 模式不需要持久化到文件，直接在子进程中通过 socket 传输给 slaves；rdb file 在子进程中持久化到本地，在父进程中发送给 salves。另外，diskless 模式在传输完 rdb 数据后，要等待 slave 返回 replconf ack 后，才能开始增量同步。
4. 多个 slave 和 日志持久化 如何共享同一个 bgSave 任务？
    由 slave 同步请求（PSYNC/SYNC command，slave sync handshake）触发的 bgSave 可以有条件共享，其他情况触发的 bgSave 无法共享。
5. slave 如何加载 rdb file？
    slave 在将 rdb 数据持久化到本地，在完整接收后通过 [rdbLoad](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2151) 的方式加载到内存。

### BgSave 的触发

当一个 slave client 进入 fullsync 流程后会经历如下四个阶段：

+ SLAVE_STATE_WAIT_BGSAVE_START：等待 bgsave 开始
+ SLAVE_STATE_WAIT_BGSAVE_END：等待 bgsave 结束
+ SLAVE_STATE_SEND_BULK：发送 rdb 数据
+ SLAVE_STATE_ONLINE：发送结束，标记为上线

在 redis 中有以下几个场景可能触发 Bgsave ：

+ 执行 PSYNC 和 SYNC command：当不满足部分同步条件时，可能会触发全量同步执行 bgSave；
+ [replicationCron](https://github.com/redis/redis/blob/5.0/src/replication.c#L2578)：每间隔 1s 执行一次，检查当前是否有处于 WAIT_BGSAVE_START 状态的 slave，如果有则开启 bgSave；
+ [serverCron](https://github.com/redis/redis/blob/5.0/src/server.c#L1111)：在 Bgsave 结束时，子进程通过 serverCron 检查执行完 bgSave的结果时可能会再次启动 bgSave 任务(下面会详细分析)；
+ BgSave/BgRewrite 命令：主动调用命令去生成 RDB file
+ 日志配置：配置了 RDB 日志或 aof-preamble 日志

在 PSYNC 和 SYNC command 中会即使不满足全量同步条件也不一定会立即触发 bgSave 命令:

1. 如果当前开启了一个 diskless 的 bgSave 任务，则等待下一轮 bgSave 任务；
2. 如果当前开启了一个 rdb file 的 bgSave 任务，检测当前 slaves 队列中是否有处于 SLAVE_STATE_WAIT_BGSAVE_END 状态的任务，且 slave 的 repl_capa 包含 调用 PSYNC/SYNC 的 client 的 repl_capa，此时 client 附加到当前任务，直接进入 SLAVE_STATE_WAIT_BGSAVE_END 状态；
3. 1 和 2 都不满的情况下，如果是 client 与 server 都支持 diskless，则等待下一轮 bgSave 任务，否则如果当前没有 aof_rewrite 任务则开启一个 bgSave 任务；

具体实现[syncCommand](https://github.com/redis/redis/blob/5.0/src/replication.c#L629)如下：

``` C
/* SYNC and PSYNC command implemenation. */
void syncCommand(client *c) {
   ... ... 

    /* CASE 1: BGSAVE is in progress, with disk target. */
    if (server.rdb_child_pid != -1 &&
        server.rdb_child_type == RDB_CHILD_TYPE_DISK)
    {
        /* Ok a background save is in progress. Let's check if it is a good
         * one for replication, i.e. if there is another slave that is
         * registering differences since the server forked to save. */
        client *slave;
        listNode *ln;
        listIter li;

        listRewind(server.slaves,&li);
        while((ln = listNext(&li))) {
            slave = ln->value;
            if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_END) break;
        }
        /* To attach this slave, we check that it has at least all the
         * capabilities of the slave that triggered the current BGSAVE. */
        if (ln && ((c->slave_capa & slave->slave_capa) == slave->slave_capa)) {
            /* Perfect, the server is already registering differences for
             * another slave. Set the right state, and copy the buffer. */
            copyClientOutputBuffer(c,slave);
            replicationSetupSlaveForFullResync(c,slave->psync_initial_offset);
            serverLog(LL_NOTICE,"Waiting for end of BGSAVE for SYNC");
        } else {
            /* No way, we need to wait for the next BGSAVE in order to
             * register differences. */
            serverLog(LL_NOTICE,"Can't attach the replica to the current BGSAVE. Waiting for next BGSAVE for SYNC");
        }

    /* CASE 2: BGSAVE is in progress, with socket target. */
    } else if (server.rdb_child_pid != -1 &&
               server.rdb_child_type == RDB_CHILD_TYPE_SOCKET)
    {
        /* There is an RDB child process but it is writing directly to
         * children sockets. We need to wait for the next BGSAVE
         * in order to synchronize. */
        serverLog(LL_NOTICE,"Current BGSAVE has socket target. Waiting for next BGSAVE for SYNC");

    /* CASE 3: There is no BGSAVE is progress. */
    } else {
        if (server.repl_diskless_sync && (c->slave_capa & SLAVE_CAPA_EOF)) {
            /* Diskless replication RDB child is created inside
             * replicationCron() since we want to delay its start a
             * few seconds to wait for more slaves to arrive. */
            if (server.repl_diskless_sync_delay)
                serverLog(LL_NOTICE,"Delay next BGSAVE for diskless SYNC");
        } else {
            /* Target is disk (or the slave is not capable of supporting
             * diskless replication) and we don't have a BGSAVE in progress,
             * let's start one. */
            if (server.aof_child_pid == -1) {
                startBgsaveForReplication(c->slave_capa);
            } else {
                serverLog(LL_NOTICE,
                    "No BGSAVE in progress, but an AOF rewrite is active. "
                    "BGSAVE for replication delayed");
            }
        }
    }
    return;
}
```

这里讲解一下[replicationSetupSlaveForFullResync](https://github.com/redis/redis/blob/5.0/src/replication.c#L419)函数，该函数将 client->replstate 设置为 SLAVE_STATE_WAIT_BGSAVE_END 状态，然后会向 client 发送`+FULLRESYNC repli offset` 命令，在下文中的启动 bgSave 流程中也会调用该函数，具体实现如下：

``` C

/* Send a FULLRESYNC reply in the specific case of a full resynchronization,
 * as a side effect setup the slave for a full sync in different ways:
 *
 * 1) Remember, into the slave client structure, the replication offset
 *    we sent here, so that if new slaves will later attach to the same
 *    background RDB saving process (by duplicating this client output
 *    buffer), we can get the right offset from this slave.
 * 2) Set the replication state of the slave to WAIT_BGSAVE_END so that
 *    we start accumulating differences from this point.
 * 3) Force the replication stream to re-emit a SELECT statement so
 *    the new slave incremental differences will start selecting the
 *    right database number.
 *
 * Normally this function should be called immediately after a successful
 * BGSAVE for replication was started, or when there is one already in
 * progress that we attached our slave to. */
int replicationSetupSlaveForFullResync(client *slave, long long offset) {
    char buf[128];
    int buflen;

    slave->psync_initial_offset = offset;
    slave->replstate = SLAVE_STATE_WAIT_BGSAVE_END;
    /* We are going to accumulate the incremental changes for this
     * slave as well. Set slaveseldb to -1 in order to force to re-emit
     * a SELECT statement in the replication stream. */
    server.slaveseldb = -1;

    /* Don't send this reply to slaves that approached us with
     * the old SYNC command. */
    if (!(slave->flags & CLIENT_PRE_PSYNC)) {
        buflen = snprintf(buf,sizeof(buf),"+FULLRESYNC %s %lld\r\n",
                          server.replid,offset);
        if (write(slave->fd,buf,buflen) != buflen) {
            freeClientAsync(slave);
            return C_ERR;
        }
    }
    return C_OK;
```

replicationCron 作为处理主从复制的核心函数是在 serverCron 中被调用的，它里面包含了几乎所有处理主从复制的操作：

``` mermaid!
flowchart TB
    start([start])
    exit([end])
    cancelReplHandshake[cancel replication hand shake <br> if hand shake timeout.]
    cancelReplHandshake1[cancel replication hand shake <br> if bulk transfer I/O timeout.]
    freeMaster[free the master client <br> if the client is timeout.]
    connMaster[connect to master if the node is slave <br> in REPL_STATE_CONNECT state.]
    sendAck[send repl ack if the node is slave <br> and master supports PSYNC.]
    pingSubSlaves[ping slaves <br> if there are sub slaves.]
    sendNewLine[send newline char to no-diskless slaves <br> waiting bgsave.]
    disconnTimeoutSlaves[Disconnect timedout slaves.]
    cleanBacklog["free the back log after some (configured) time <br> if the node is master without slaves."]
    flushScriptCache[flush scripts cache if the node <br> disabled aof is without slaves.]
    startBgSave[Start a BGSAVE good for replication <br> if there are slaves in WAIT_BGSAVE_START state.]
    refreshSlaves[Refresh the number of slaves <br> with lag <= min-slaves-max-lag]
    start-->cancelReplHandshake-->cancelReplHandshake1-->freeMaster
    freeMaster-->connMaster-->sendAck-->pingSubSlaves-->sendNewLine
    sendNewLine-->disconnTimeoutSlaves-->cleanBacklog-->flushScriptCache 
    flushScriptCache-->startBgSave-->refreshSlaves-->exit
```

其中还有很多细节，不在这里展开了，本文主要关注 bgSave 的部分，它会在没有开启 bgSave 和 aofSave 子进程的前提下，检查当前所有 slave 的 capability，找到它们的 minicapa（取交集）。当开启 diskless 时会等待一段时间（`repl_diskless_sync_delay`），然后开启 bgSave 任务：

``` C
/* --------------------------- REPLICATION CRON  ---------------------------- */

/* Replication cron function, called 1 time per second. */
void replicationCron(void) {
    ... ...
      /* Start a BGSAVE good for replication if we have slaves in
     * WAIT_BGSAVE_START state.
     *
     * In case of diskless replication, we make sure to wait the specified
     * number of seconds (according to configuration) so that other slaves
     * have the time to arrive before we start streaming. */
    if (server.rdb_child_pid == -1 && server.aof_child_pid == -1) {
        time_t idle, max_idle = 0;
        int slaves_waiting = 0;
        int mincapa = -1;
        listNode *ln;
        listIter li;

        listRewind(server.slaves,&li);
        while((ln = listNext(&li))) {
            client *slave = ln->value;
            if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
                idle = server.unixtime - slave->lastinteraction;
                if (idle > max_idle) max_idle = idle;
                slaves_waiting++;
                mincapa = (mincapa == -1) ? slave->slave_capa :
                                            (mincapa & slave->slave_capa);
            }
        }

        if (slaves_waiting &&
            (!server.repl_diskless_sync ||
             max_idle > server.repl_diskless_sync_delay))
        {
            /* Start the BGSAVE. The called function may start a
             * BGSAVE with socket target or disk target depending on the
             * configuration and slaves capabilities. */
            startBgsaveForReplication(mincapa);
        }
    }
    ... ...
}
```

serverCron 中调用的链路比较复杂，下面会讲到，简单的来讲是在检查 bgSave 子进程返回结果时，查看当前是否有需要 bgSave 的 slave，如果有则会开启新一轮 bgSave。至此回答了第一个问题。

### RDB 数据的生成

RDB 数据的字段格式依次如下：

+ MAGIC(9 byte): REDIS$RDB_VESION，RDB_VERSION format %04d，例如 0009
+ InfoAUXFileds: 包含字段依次如下
    - redis-ver[all]: REDIS version，例如 5.0.12
    - redis-bits[all]: redis 所在的主机位数，例如 32
    - ctime[all]: rdb 创建的时间
    - used-mem[all]: 当前所存储数据使用内存的大小，在restore的时候可以依据该字段提前分配内存
    - repl-stream-db[bgSave]: 当前的 select db，保证在全量同步完成后都可以切换到同一个db
    - repl-id[bgSave]: 当前的 repl-id
    - repl-offset[bgSave]: 当前的 repl-offset
    - aof-preamble[aof]: 在开启 aof preamble 功能时，会重写 aof 日志到 rdb file，此时会携带该标致
+ []ModuleAUX: redis 允许用户加载自定义数据模块，这些支持aux_save 方法且开启 aux_save_tiggers 的模块信息（名字、版本号、模块自定义AUX信息等）也要保存在 RDB file中，这样才能保证在加载自定义数据时找到对应的 module
+ []DBdata: 包含字段依次如下
    - DB_NUM: 数据库id
    - DB_SIZE: 数据大小
    - EXPIRES_SIZE: 数据过期时间集合大小
    - []KEY: key数据，包括 key、value、expire
+ []Script: Script数据，与AuxFileds格式相同，key 为 lua、filed 为 script data，即会有多个 lua 字段
+ []ModuleAUX: 支持 aux_save 方法但没有开启 aux_save_tiggers 的模块信息
+ CheckSum(8 byte): 校验码

RDB 中还有很多种类的 OPCODE 用来标识数据类型，除了MAGIC 字段外，每一个字段都是由：`OPCODE + LENGTH + DATA` 格式组成的，这里不详细展开，其核心函数为[rdbSaveRio]()：

``` C
/* Produces a dump of the database in RDB format sending it to the specified
 * Redis I/O channel. On success C_OK is returned, otherwise C_ERR
 * is returned and part of the output, or all the output, can be
 * missing because of I/O errors.
 *
 * When the function returns C_ERR and if 'error' is not NULL, the
 * integer pointed by 'error' is set to the value of errno just after the I/O
 * error. */
int rdbSaveRio(rio *rdb, int *error, int flags, rdbSaveInfo *rsi) {
    dictIterator *di = NULL;
    dictEntry *de;
    char magic[10];
    int j;
    uint64_t cksum;
    size_t processed = 0;

    if (server.rdb_checksum)
        rdb->update_cksum = rioGenericUpdateChecksum;
    snprintf(magic,sizeof(magic),"REDIS%04d",RDB_VERSION);
    if (rdbWriteRaw(rdb,magic,9) == -1) goto werr;
    if (rdbSaveInfoAuxFields(rdb,flags,rsi) == -1) goto werr;
    if (rdbSaveModulesAux(rdb, REDISMODULE_AUX_BEFORE_RDB) == -1) goto werr;

    for (j = 0; j < server.dbnum; j++) {
        redisDb *db = server.db+j;
        dict *d = db->dict;
        if (dictSize(d) == 0) continue;
        di = dictGetSafeIterator(d);

        /* Write the SELECT DB opcode */
        if (rdbSaveType(rdb,RDB_OPCODE_SELECTDB) == -1) goto werr;
        if (rdbSaveLen(rdb,j) == -1) goto werr;

        /* Write the RESIZE DB opcode. We trim the size to UINT32_MAX, which
         * is currently the largest type we are able to represent in RDB sizes.
         * However this does not limit the actual size of the DB to load since
         * these sizes are just hints to resize the hash tables. */
        uint64_t db_size, expires_size;
        db_size = dictSize(db->dict);
        expires_size = dictSize(db->expires);
        if (rdbSaveType(rdb,RDB_OPCODE_RESIZEDB) == -1) goto werr;
        if (rdbSaveLen(rdb,db_size) == -1) goto werr;
        if (rdbSaveLen(rdb,expires_size) == -1) goto werr;

        /* Iterate this DB writing every entry */
        while((de = dictNext(di)) != NULL) {
            sds keystr = dictGetKey(de);
            robj key, *o = dictGetVal(de);
            long long expire;

            initStaticStringObject(key,keystr);
            expire = getExpire(db,&key);
            if (rdbSaveKeyValuePair(rdb,&key,o,expire) == -1) goto werr;

            /* When this RDB is produced as part of an AOF rewrite, move
             * accumulated diff from parent to child while rewriting in
             * order to have a smaller final write. */
            if (flags & RDB_SAVE_AOF_PREAMBLE &&
                rdb->processed_bytes > processed+AOF_READ_DIFF_INTERVAL_BYTES)
            {
                processed = rdb->processed_bytes;
                aofReadDiffFromParent();
            }
        }
        dictReleaseIterator(di);
        di = NULL; /* So that we don't release it again on error. */
    }

    /* If we are storing the replication information on disk, persist
     * the script cache as well: on successful PSYNC after a restart, we need
     * to be able to process any EVALSHA inside the replication backlog the
     * master will send us. */
    if (rsi && dictSize(server.lua_scripts)) {
        di = dictGetIterator(server.lua_scripts);
        while((de = dictNext(di)) != NULL) {
            robj *body = dictGetVal(de);
            if (rdbSaveAuxField(rdb,"lua",3,body->ptr,sdslen(body->ptr)) == -1)
                goto werr;
        }
        dictReleaseIterator(di);
        di = NULL; /* So that we don't release it again on error. */
    }

    if (rdbSaveModulesAux(rdb, REDISMODULE_AUX_AFTER_RDB) == -1) goto werr;

    /* EOF opcode */
    if (rdbSaveType(rdb,RDB_OPCODE_EOF) == -1) goto werr;

    /* CRC64 checksum. It will be zero if checksum computation is disabled, the
     * loading code skips the check in this case. */
    cksum = rdb->cksum;
    memrev64ifbe(&cksum);
    if (rioWrite(rdb,&cksum,8) == 0) goto werr;
    return C_OK;

werr:
    if (error) *error = errno;
    if (di) dictReleaseIterator(di);
    return C_ERR;
}
```

至此解答了上述的第二个问题。

### Diskless 和 RDB file

在 2.6.0 版本后 redis 引入了 diskless（详情见[上一篇文章](https://saffraan.github.io/redis_psync_protocol/))后，支持两种 RDB 传输模式：

+ diskless: 先将 eofmark（40个字节的HEX char随机字符串） 作为 replpreamble configuration 发送给 slave，然后传输 RDB data，当再次收到 eofmark 时意味着传输终止；
    +FULLRESYNC replid offset
    \$EOF: \$eofmark\r\n
    RDB data
    $eofmark
+ rdbfile: 先将 file length 作为 replpreamble configuration 发送给 slave，然后传输 RDB data，当接收到最够的数据后传输终止；
    +FULLRESYNC replid offset
    $\<length\>\r\n
    RDB data

[startBgsaveForReplication](https://github.com/redis/redis/blob/5.0/src/replication.c#L564) 是 bgsave 开启的核心函数，在开启后fork() 创建一个子进程去执行 bgsave 的任务，父进程通过 pipe 来接收子进程输出的消息，实现进程间通信。针对于满足 diskless 情况会调用[rdbSaveToSlavesSockets](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2312) 函数，否则使用[rdbSaveBackground](https://github.com/redis/redis/blob/5.0/src/rdb.c#L1328) 函数：

``` mermaid!
graph TB
    start([begin])
    exit([end])

    diskless{save to sockets?}
    saveToss[rdbSaveToSlavesSockets]
    saveTof[rdbSaveBackground]
    OK{return ok?}
    TerminalSync[set replstate REPL_STATE_NONE,<br> close client after reply.]

    isNotDiskless{save to file?}
    setupFullsync[setup the salves for a full resync.]
    flushScript[flush the script cache.]

    start-->diskless
    diskless-->|Yes|saveToss-->OK
    diskless-->|No|saveTof-->OK
    OK-->|No|TerminalSync-->exit
    OK-->|Yes|isNotDiskless
    isNotDiskless-->|Yes|setupFullsync-->flushScript
    isNotDiskless-->|No|flushScript
    flushScript-->exit 
```


具体实现如下：

``` C
/* Start a BGSAVE for replication goals, which is, selecting the disk or
 * socket target depending on the configuration, and making sure that
 * the script cache is flushed before to start.
 *
 * The mincapa argument is the bitwise AND among all the slaves capabilities
 * of the slaves waiting for this BGSAVE, so represents the slave capabilities
 * all the slaves support. Can be tested via SLAVE_CAPA_* macros.
 *
 * Side effects, other than starting a BGSAVE:
 *
 * 1) Handle the slaves in WAIT_START state, by preparing them for a full
 *    sync if the BGSAVE was successfully started, or sending them an error
 *    and dropping them from the list of slaves.
 *
 * 2) Flush the Lua scripting script cache if the BGSAVE was actually
 *    started.
 *
 * Returns C_OK on success or C_ERR otherwise. */
int startBgsaveForReplication(int mincapa) {
    int retval;
    int socket_target = server.repl_diskless_sync && (mincapa & SLAVE_CAPA_EOF);
    listIter li;
    listNode *ln;

    serverLog(LL_NOTICE,"Starting BGSAVE for SYNC with target: %s",
        socket_target ? "replicas sockets" : "disk");

    rdbSaveInfo rsi, *rsiptr;
    rsiptr = rdbPopulateSaveInfo(&rsi);
    /* Only do rdbSave* when rsiptr is not NULL,
     * otherwise slave will miss repl-stream-db. */
    if (rsiptr) {
        if (socket_target)
            retval = rdbSaveToSlavesSockets(rsiptr);
        else
            retval = rdbSaveBackground(server.rdb_filename,rsiptr);
    } else {
        serverLog(LL_WARNING,"BGSAVE for replication: replication information not available, can't generate the RDB file right now. Try later.");
        retval = C_ERR;
    }

    /* If we failed to BGSAVE, remove the slaves waiting for a full
     * resynchorinization from the list of salves, inform them with
     * an error about what happened, close the connection ASAP. */
    if (retval == C_ERR) {
        serverLog(LL_WARNING,"BGSAVE for replication failed");
        listRewind(server.slaves,&li);
        while((ln = listNext(&li))) {
            client *slave = ln->value;

            if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
                slave->replstate = REPL_STATE_NONE;
                slave->flags &= ~CLIENT_SLAVE;
                listDelNode(server.slaves,ln);
                addReplyError(slave,
                    "BGSAVE failed, replication can't continue");
                slave->flags |= CLIENT_CLOSE_AFTER_REPLY;
            }
        }
        return retval;
    }

    /* If the target is socket, rdbSaveToSlavesSockets() already setup
     * the salves for a full resync. Otherwise for disk target do it now.*/
    if (!socket_target) {
        listRewind(server.slaves,&li);
        while((ln = listNext(&li))) {
            client *slave = ln->value;

            if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
                    replicationSetupSlaveForFullResync(slave,
                            getPsyncInitialOffset());
            }
        }
    }

    /* Flush the script cache, since we need that slave differences are
     * accumulated without requiring slaves to match our cached scripts. */
    if (retval == C_OK) replicationScriptCacheFlush();
    return retval;
}
```

rdbSaveToSlavesSockets 里面会调用 [replicationSetupSlaveForFullResync](https://github.com/redis/redis/blob/5.0/src/replication.c#L419) 函数，所以无需在外部再次调用，在 fork 子进程后，父进程函数会立即返回，不会阻塞父进程的执行：

``` mermaid!
graph TB
    start([begin]);exit([end]);
    createPipe[create pipes.];
    setupFullsync[setup the salves for a full resync.]
    fork[fork a child process.]
    saveDataToss[[save data to sockets.]]
    return[write results into pipe.]
    start-->createPipe-->setupFullsync-->fork
    fork-.->|Child|saveDataToss-->return-.->exit
    fork-->|Parent|exit
```

具体实现如下：

``` C
/* Spawn an RDB child that writes the RDB to the sockets of the slaves
 * that are currently in SLAVE_STATE_WAIT_BGSAVE_START state. */
int rdbSaveToSlavesSockets(rdbSaveInfo *rsi) {
    int *fds;
    uint64_t *clientids;
    int numfds;
    listNode *ln;
    listIter li;
    pid_t childpid;
    long long start;
    int pipefds[2];

    if (server.aof_child_pid != -1 || server.rdb_child_pid != -1) return C_ERR;

    /* Before to fork, create a pipe that will be used in order to
     * send back to the parent the IDs of the slaves that successfully
     * received all the writes. */
    if (pipe(pipefds) == -1) return C_ERR;
    server.rdb_pipe_read_result_from_child = pipefds[0];
    server.rdb_pipe_write_result_to_parent = pipefds[1];

    /* Collect the file descriptors of the slaves we want to transfer
     * the RDB to, which are i WAIT_BGSAVE_START state. */
    fds = zmalloc(sizeof(int)*listLength(server.slaves));
    /* We also allocate an array of corresponding client IDs. This will
     * be useful for the child process in order to build the report
     * (sent via unix pipe) that will be sent to the parent. */
    clientids = zmalloc(sizeof(uint64_t)*listLength(server.slaves));
    numfds = 0;

    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
            clientids[numfds] = slave->id;
            fds[numfds++] = slave->fd;
            replicationSetupSlaveForFullResync(slave,getPsyncInitialOffset());
            /* Put the socket in blocking mode to simplify RDB transfer.
             * We'll restore it when the children returns (since duped socket
             * will share the O_NONBLOCK attribute with the parent). */
            anetBlock(NULL,slave->fd);
            anetSendTimeout(NULL,slave->fd,server.repl_timeout*1000);
        }
    }

    /* Create the child process. */
    openChildInfoPipe();
    start = ustime();
    if ((childpid = fork()) == 0) {
        /* Child */
        int retval;
        rio slave_sockets;

        rioInitWithFdset(&slave_sockets,fds,numfds);
        zfree(fds);

        closeClildUnusedResourceAfterFork();
        redisSetProcTitle("redis-rdb-to-slaves");

        retval = rdbSaveRioWithEOFMark(&slave_sockets,NULL,rsi);
        if (retval == C_OK && rioFlush(&slave_sockets) == 0)
            retval = C_ERR;

        if (retval == C_OK) {
            size_t private_dirty = zmalloc_get_private_dirty(-1);

            if (private_dirty) {
                serverLog(LL_NOTICE,
                    "RDB: %zu MB of memory used by copy-on-write",
                    private_dirty/(1024*1024));
            }

            server.child_info_data.cow_size = private_dirty;
            sendChildInfo(CHILD_INFO_TYPE_RDB);

            /* If we are returning OK, at least one slave was served
             * with the RDB file as expected, so we need to send a report
             * to the parent via the pipe. The format of the message is:
             *
             * <len> <slave[0].id> <slave[0].error> ...
             *
             * len, slave IDs, and slave errors, are all uint64_t integers,
             * so basically the reply is composed of 64 bits for the len field
             * plus 2 additional 64 bit integers for each entry, for a total
             * of 'len' entries.
             *
             * The 'id' represents the slave's client ID, so that the master
             * can match the report with a specific slave, and 'error' is
             * set to 0 if the replication process terminated with a success
             * or the error code if an error occurred. */
            void *msg = zmalloc(sizeof(uint64_t)*(1+2*numfds));
            uint64_t *len = msg;
            uint64_t *ids = len+1;
            int j, msglen;

            *len = numfds;
            for (j = 0; j < numfds; j++) {
                *ids++ = clientids[j];
                *ids++ = slave_sockets.io.fdset.state[j];
            }

            /* Write the message to the parent. If we have no good slaves or
             * we are unable to transfer the message to the parent, we exit
             * with an error so that the parent will abort the replication
             * process with all the childre that were waiting. */
            msglen = sizeof(uint64_t)*(1+2*numfds);
            if (*len == 0 ||
                write(server.rdb_pipe_write_result_to_parent,msg,msglen)
                != msglen)
            {
                retval = C_ERR;
            }
            zfree(msg);
        }
        zfree(clientids);
        rioFreeFdset(&slave_sockets);
        exitFromChild((retval == C_OK) ? 0 : 1);
    } else {
        /* Parent */
        if (childpid == -1) {
            serverLog(LL_WARNING,"Can't save in background: fork: %s",
                strerror(errno));

            /* Undo the state change. The caller will perform cleanup on
             * all the slaves in BGSAVE_START state, but an early call to
             * replicationSetupSlaveForFullResync() turned it into BGSAVE_END */
            listRewind(server.slaves,&li);
            while((ln = listNext(&li))) {
                client *slave = ln->value;
                int j;

                for (j = 0; j < numfds; j++) {
                    if (slave->id == clientids[j]) {
                        slave->replstate = SLAVE_STATE_WAIT_BGSAVE_START;
                        break;
                    }
                }
            }
            close(pipefds[0]);
            close(pipefds[1]);
            closeChildInfoPipe();
        } else {
            server.stat_fork_time = ustime()-start;
            server.stat_fork_rate = (double) zmalloc_used_memory() * 1000000 / server.stat_fork_time / (1024*1024*1024); /* GB per second. */
            latencyAddSampleIfNeeded("fork",server.stat_fork_time/1000);

            serverLog(LL_NOTICE,"Background RDB transfer started by pid %d",
                childpid);
            server.rdb_save_time_start = time(NULL);
            server.rdb_child_pid = childpid;
            server.rdb_child_type = RDB_CHILD_TYPE_SOCKET;
            updateDictResizePolicy();
        }
        zfree(clientids);
        zfree(fds);
        return (childpid == -1) ? C_ERR : C_OK;
    }
    return C_OK; /* Unreached. */
}


/* This is just a wrapper to rdbSaveRio() that additionally adds a prefix
 * and a suffix to the generated RDB dump. The prefix is:
 *
 * $EOF:<40 bytes unguessable hex string>\r\n
 *
 * While the suffix is the 40 bytes hex string we announced in the prefix.
 * This way processes receiving the payload can understand when it ends
 * without doing any processing of the content. */
int rdbSaveRioWithEOFMark(rio *rdb, int *error, rdbSaveInfo *rsi) {
    char eofmark[RDB_EOF_MARK_SIZE];

    getRandomHexChars(eofmark,RDB_EOF_MARK_SIZE);
    if (error) *error = 0;
    if (rioWrite(rdb,"$EOF:",5) == 0) goto werr;
    if (rioWrite(rdb,eofmark,RDB_EOF_MARK_SIZE) == 0) goto werr;
    if (rioWrite(rdb,"\r\n",2) == 0) goto werr;
    if (rdbSaveRio(rdb,error,RDB_SAVE_NONE,rsi) == C_ERR) goto werr;
    if (rioWrite(rdb,eofmark,RDB_EOF_MARK_SIZE) == 0) goto werr;
    return C_OK;

werr: /* Write error. */
    /* Set 'error' only if not already set by rdbSaveRio() call. */
    if (error && *error == 0) *error = errno;
    return C_ERR;
}

/* Produces a dump of the database in RDB format sending it to the specified
 * Redis I/O channel. On success C_OK is returned, otherwise C_ERR
 * is returned and part of the output, or all the output, can be
 * missing because of I/O errors.
 *
 * When the function returns C_ERR and if 'error' is not NULL, the
 * integer pointed by 'error' is set to the value of errno just after the I/O
 * error. */
int rdbSaveRio(rio *rdb, int *error, int flags, rdbSaveInfo *rsi) {
    ... ...
}
```

rdbSaveBackground 也会 fork 一个子进程，在子进程中执行写 RDB 文件的操作，主进程的函数也会立即返回，不过与rdbSaveToSlavesSockets 不同的是数据的传输不是在子进程内：

``` mermaid!
graph TB
    start([start]);exit([end])
    fork[fork a child process.]
    return[write results into pipe]
    savefile[save data into rdb file.]
    start-->fork-->|Parent|exit
    fork-.->|Child|savefile-->return-.->exit
```

具体实现如下：

``` C
int rdbSaveBackground(char *filename, rdbSaveInfo *rsi) {
    pid_t childpid;
    long long start;

    if (server.aof_child_pid != -1 || server.rdb_child_pid != -1) return C_ERR;

    server.dirty_before_bgsave = server.dirty;
    server.lastbgsave_try = time(NULL);
    openChildInfoPipe();

    start = ustime();
    if ((childpid = fork()) == 0) {
        int retval;

        /* Child */
        closeClildUnusedResourceAfterFork();
        redisSetProcTitle("redis-rdb-bgsave");
        retval = rdbSave(filename,rsi);
        if (retval == C_OK) {
            size_t private_dirty = zmalloc_get_private_dirty(-1);

            if (private_dirty) {
                serverLog(LL_NOTICE,
                    "RDB: %zu MB of memory used by copy-on-write",
                    private_dirty/(1024*1024));
            }

            server.child_info_data.cow_size = private_dirty;
            sendChildInfo(CHILD_INFO_TYPE_RDB);
        }
        exitFromChild((retval == C_OK) ? 0 : 1);
    } else {
        /* Parent */
        server.stat_fork_time = ustime()-start;
        server.stat_fork_rate = (double) zmalloc_used_memory() * 1000000 / server.stat_fork_time / (1024*1024*1024); /* GB per second. */
        latencyAddSampleIfNeeded("fork",server.stat_fork_time/1000);
        if (childpid == -1) {
            closeChildInfoPipe();
            server.lastbgsave_status = C_ERR;
            serverLog(LL_WARNING,"Can't save in background: fork: %s",
                strerror(errno));
            return C_ERR;
        }
        serverLog(LL_NOTICE,"Background saving started by pid %d",childpid);
        server.rdb_save_time_start = time(NULL);
        server.rdb_child_pid = childpid;
        server.rdb_child_type = RDB_CHILD_TYPE_DISK;
        updateDictResizePolicy();
        return C_OK;
    }
    return C_OK; /* unreached */
}
```

在 `save to file` 的情况下，数据最后发送的操作是在主进程完成的，它的触发时机是在 [serverCron](https://github.com/redis/redis/blob/5.0/src/server.c#L1111) 处理 bgSaveDone 的时候，主要实现函数为 [backgroundSaveDoneHandlerDisk](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2167) 和 [backgroundSaveDoneHandlerSocket](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2203)，其中  backgroundSaveDoneHandlerDisk 包含 RDB file 数据发送的核心逻辑，它调用 [updateSlavesWaitingBgsave](https://github.com/redis/redis/blob/5.0/src/replication.c#L946) 函数将 [sendBulkToSlave](https://github.com/redis/redis/blob/5.0/src/replication.c#L876)函数绑定到 `slave->fd`的可写入事件上。

``` C
/* This is our timer interrupt, called server.hz times per second.
 * Here is where we do a number of things that need to be done asynchronously.
 * For instance:
 *
 * - Active expired keys collection (it is also performed in a lazy way on
 *   lookup).
 * - Software watchdog.
 * - Update some statistic.
 * - Incremental rehashing of the DBs hash tables.
 * - Triggering BGSAVE / AOF rewrite, and handling of terminated children.
 * - Clients timeout of different kinds.
 * - Replication reconnection.
 * - Many more...
 *
 * Everything directly called here will be called server.hz times per second,
 * so in order to throttle execution of things we want to do less frequently
 * a macro is used: run_with_period(milliseconds) { .... }
 */

int serverCron(struct aeEventLoop *eventLoop, long long id, void *clientData) {
    ... ...

    /* Check if a background saving or AOF rewrite in progress terminated. */
    if (server.rdb_child_pid != -1 || server.aof_child_pid != -1 ||
        ldbPendingChildren())
    {
        int statloc;
        pid_t pid;

        if ((pid = wait3(&statloc,WNOHANG,NULL)) != 0) {
            int exitcode = WEXITSTATUS(statloc);
            int bysignal = 0;

            if (WIFSIGNALED(statloc)) bysignal = WTERMSIG(statloc);

            if (pid == -1) {
                serverLog(LL_WARNING,"wait3() returned an error: %s. "
                    "rdb_child_pid = %d, aof_child_pid = %d",
                    strerror(errno),
                    (int) server.rdb_child_pid,
                    (int) server.aof_child_pid);
            } else if (pid == server.rdb_child_pid) {
                backgroundSaveDoneHandler(exitcode,bysignal);
                if (!bysignal && exitcode == 0) receiveChildInfo();
            } else if (pid == server.aof_child_pid) {
                backgroundRewriteDoneHandler(exitcode,bysignal);
                if (!bysignal && exitcode == 0) receiveChildInfo();
            } else {
                if (!ldbRemoveChild(pid)) {
                    serverLog(LL_WARNING,
                        "Warning, detected child with unmatched pid: %ld",
                        (long)pid);
                }
            }
            updateDictResizePolicy();
            closeChildInfoPipe();
        }
    } else {
        /* If there is not a background saving/rewrite in progress check if
         * we have to save/rewrite now. */
        ... ... 
        /* Trigger an AOF rewrite if needed. */
        ... ...
    }
  ... ... 
}


/* A background saving child (BGSAVE) terminated its work. Handle this.
 * This function covers the case of actual BGSAVEs. */
void backgroundSaveDoneHandlerDisk(int exitcode, int bysignal) {
    ... ... 
    /* Possibly there are slaves waiting for a BGSAVE in order to be served
     * (the first stage of SYNC is a bulk transfer of dump.rdb) */
    updateSlavesWaitingBgsave((!bysignal && exitcode == 0) ? C_OK : C_ERR, RDB_CHILD_TYPE_DISK);
}

/* When a background RDB saving/transfer terminates, call the right handler. */
void backgroundSaveDoneHandler(int exitcode, int bysignal) {
    switch(server.rdb_child_type) {
    case RDB_CHILD_TYPE_DISK:
        backgroundSaveDoneHandlerDisk(exitcode,bysignal);
        break;
    case RDB_CHILD_TYPE_SOCKET:
        backgroundSaveDoneHandlerSocket(exitcode,bysignal);
        break;
    default:
        serverPanic("Unknown RDB child type.");
        break;
    }
}


/* This function is called at the end of every background saving,
 * or when the replication RDB transfer strategy is modified from
 * disk to socket or the other way around.
 *
 * The goal of this function is to handle slaves waiting for a successful
 * background saving in order to perform non-blocking synchronization, and
 * to schedule a new BGSAVE if there are slaves that attached while a
 * BGSAVE was in progress, but it was not a good one for replication (no
 * other slave was accumulating differences).
 *
 * The argument bgsaveerr is C_OK if the background saving succeeded
 * otherwise C_ERR is passed to the function.
 * The 'type' argument is the type of the child that terminated
 * (if it had a disk or socket target). */
void updateSlavesWaitingBgsave(int bgsaveerr, int type) {
    listNode *ln;
    int startbgsave = 0;
    int mincapa = -1;
    listIter li;

    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
            ... ...
        } else if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_END) {
           ... ...
        } else {
            if (bgsaveerr != C_OK) {
                freeClient(slave);
                serverLog(LL_WARNING,"SYNC failed. BGSAVE child returned an error");
                continue;
            }
            if ((slave->repldbfd = open(server.rdb_filename,O_RDONLY)) == -1 ||
                redis_fstat(slave->repldbfd,&buf) == -1) {
                freeClient(slave);
                serverLog(LL_WARNING,"SYNC failed. Can't open/stat DB after BGSAVE: %s", strerror(errno));
                continue;
            }
            slave->repldboff = 0;
            slave->repldbsize = buf.st_size;
            slave->replstate = SLAVE_STATE_SEND_BULK;
            slave->replpreamble = sdscatprintf(sdsempty(),"$%lld\r\n",
                (unsigned long long) slave->repldbsize);

            aeDeleteFileEvent(server.el,slave->fd,AE_WRITABLE);
            if (aeCreateFileEvent(server.el, slave->fd, AE_WRITABLE, sendBulkToSlave, slave) == AE_ERR) {
                freeClient(slave);
                continue;
            }
        }
    }
    ... ...
}


void sendBulkToSlave(aeEventLoop *el, int fd, void *privdata, int mask) {
    client *slave = privdata;
    UNUSED(el);
    UNUSED(mask);
    char buf[PROTO_IOBUF_LEN];
    ssize_t nwritten, buflen;

    /* Before sending the RDB file, we send the preamble as configured by the
     * replication process. Currently the preamble is just the bulk count of
     * the file in the form "$<length>\r\n". */
    if (slave->replpreamble) {
        nwritten = write(fd,slave->replpreamble,sdslen(slave->replpreamble));
        if (nwritten == -1) {
            serverLog(LL_VERBOSE,"Write error sending RDB preamble to replica: %s",
                strerror(errno));
            freeClient(slave);
            return;
        }
        server.stat_net_output_bytes += nwritten;
        sdsrange(slave->replpreamble,nwritten,-1);
        if (sdslen(slave->replpreamble) == 0) {
            sdsfree(slave->replpreamble);
            slave->replpreamble = NULL;
            /* fall through sending data. */
        } else {
            return;
        }
    }

    /* If the preamble was already transferred, send the RDB bulk data. */
    lseek(slave->repldbfd,slave->repldboff,SEEK_SET);
    buflen = read(slave->repldbfd,buf,PROTO_IOBUF_LEN);
    if (buflen <= 0) {
        serverLog(LL_WARNING,"Read error sending DB to replica: %s",
            (buflen == 0) ? "premature EOF" : strerror(errno));
        freeClient(slave);
        return;
    }
    if ((nwritten = write(fd,buf,buflen)) == -1) {
        if (errno != EAGAIN) {
            serverLog(LL_WARNING,"Write error sending DB to replica: %s",
                strerror(errno));
            freeClient(slave);
        }
        return;
    }
    slave->repldboff += nwritten;
    server.stat_net_output_bytes += nwritten;
    if (slave->repldboff == slave->repldbsize) {
        close(slave->repldbfd);
        slave->repldbfd = -1;
        aeDeleteFileEvent(server.el,slave->fd,AE_WRITABLE);
        putSlaveOnline(slave);
    }
}
```

在 updateSlavesWaitingBgsave 函数中与 replicationCron 会统计当前是否有 slave 处于 SLAVE_STATE_WAIT_BGSAVE_START 状态，如果有则会开启一个 bgSave 任务。

``` C
void updateSlavesWaitingBgsave(int bgsaveerr, int type) {
    listNode *ln;
    int startbgsave = 0;
    int mincapa = -1;
    listIter li;

    listRewind(server.slaves,&li);
    while((ln = listNext(&li))) {
        client *slave = ln->value;

        if (slave->replstate == SLAVE_STATE_WAIT_BGSAVE_START) {
            startbgsave = 1;
            mincapa = (mincapa == -1) ? slave->slave_capa :
                                        (mincapa & slave->slave_capa);
        } else {
            ... ...
        }
    }
    if (startbgsave) startBgsaveForReplication(mincapa);
}


```

至此为止，可以部分回答第 4 个问题，即多个 slave 如何共享一个 bgSave 任务？

总结上文不难发现在，serverCron 和 replicationCron 两个入口内，都会统计多个处于 SLAVE_STATE_WAIT_BGSAVE_START 状态的 slave 的 mini capa，这样即使当前同时存在支持 EOF 和不支持 EOF 协议的 slave 也可以共享同一个 （rdb file）bgSave任务。在 PSYNC/SYNC command 入口中也会判断当前的 client 能否附加到正在执行的 （rdb file）bgSave 任务上。

此处总结上述函数的调用依赖关系：

``` mermaid!
stateDiagram-v2
    syncCommand-->replicationSetupSlaveForFullResync
    note right of replicationSetupSlaveForFullResync: from WAIT_BGSAVE_START to WAIT_BGSAVE_END.
    

    syncCommand-->startBgsaveForReplication
    note left of syncCommand: client into WAIT_BGSAVE_START in fullresync mode\nclient into ONLINE mode in psync mode. 
    replicationCron-->startBgsaveForReplication

    serverCron-->backgroundSaveDoneHandler
    backgroundSaveDoneHandler-->backgroundSaveDoneHandlerDisk: rdb_file mode
    backgroundSaveDoneHandler-->backgroundSaveDoneHandlerSocket: diskless mode

    backgroundSaveDoneHandlerDisk-->updateSlavesWaitingBgsave
    note left of updateSlavesWaitingBgsave: from WAIT_BGSAVE_END to SEND_BULK in rdb_file mode\nfrom WAIT_BGSAVE_END to ONLINE in diskless mode.
    backgroundSaveDoneHandlerSocket-->updateSlavesWaitingBgsave

    updateSlavesWaitingBgsave-->startBgsaveForReplication
    updateSlavesWaitingBgsave-->sendBulkToSlave: bind writeable event in rdb_file mode.
    

    startBgsaveForReplication-->replicationSetupSlaveForFullResync
    startBgsaveForReplication-->rdbSaveToSlavesSockets 
    startBgsaveForReplication-->rdbSaveBackground
   

    rdbSaveBackground-->rdbSave: fork child
    rdbSave-->rdbSaveRio
    rdbSaveToSlavesSockets-->replicationSetupSlaveForFullResync
    rdbSaveToSlavesSockets-->rdbSaveRioWithEOFMark: fork child
    rdbSaveRioWithEOFMark-->rdbSaveRio

    sendBulkToSlave-->putSlaveOnline
    note right of sendBulkToSlave: from SEND_BULK to ONLINE. 
    
```

### BgSave/Save 命令与 Rdb/Aof-rewrite 日志

细心的读者会发现，在上一节中没有讲到日志和 bgSave/bgRewrite 命令。主要是因为两者非主从复制触发，并非本文的重点，以下只做简单的阐述。
在 redisServer 结构体中有如下字段：

``` C
struct redisServer {
    pid_t aof_child_pid;            /* PID if rewriting process */
    ...
    pid_t rdb_child_pid;            /* PID of RDB saving child */
}
```

rdb_child_pid 用于记录执行 bgSave 任务的子进程 pid，aof_child_pid 用于记录执行 aof_rewrite 任务的子进程 pid。从字段上显而易见，**同时只能执行一个 bgSave 任务，也只能执行一个 aof_rewrite 任务**。

执行`BGSAVE` 命令时会直接去调用 rdbSaveBackground 函数去开启一个 bgSave 任务，如果此时已经开启了一个 bgSave 任务 或 aof-rewrite 任务，则会报错。如果执行`BGSAVE SCHEDULE`命令，则会开启 rdb_bgsave_scheduled（`server.rdb_bgsave_scheduled=1`），等待 serverCron （不需要执行 bgSave 任务 和 aof-rewrite 任务时）启动执行。其**优先级低于 replicationCron，但是一定会执行，即便在其上一轮已经执行过了 bgSave 任务**。

那么 slave 能 attach 到这个 bgSave 任务上嘛？结合 [bgsaveCommand](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2486) 实现和上一节的 syncCommand 解析可以看出来， 在开启了 bgSave 任务时并未向 server->slaves 队列中添加 slave，所以新加入的 slave 无法找到匹配的处于 WAIT_BGSAVE_END 状态的 slave，无法 attach 到该 bgSave 任务中。

这里顺便讲一下 `save` 命令，[saveCommand](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2471) 直接在主进程调用 rdbSave 函数，没有 fork 子进程，所以会阻塞住全局的事件循环的执行，要慎用。

`save` 和 `bgSave` 命令核心都是依赖 rdbSave 函数，会先生成一个临时文件，然后用临时文件替换（可配置，缺省为 dump.rdb）的旧文件。
具体实现如下：

``` C
void saveCommand(client *c) {
    if (server.rdb_child_pid != -1) {
        addReplyError(c,"Background save already in progress");
        return;
    }
    rdbSaveInfo rsi, *rsiptr;
    rsiptr = rdbPopulateSaveInfo(&rsi);
    if (rdbSave(server.rdb_filename,rsiptr) == C_OK) {
        addReply(c,shared.ok);
    } else {
        addReply(c,shared.err);
    }
}

/* BGSAVE [SCHEDULE] */
void bgsaveCommand(client *c) {
    int schedule = 0;

    /* The SCHEDULE option changes the behavior of BGSAVE when an AOF rewrite
     * is in progress. Instead of returning an error a BGSAVE gets scheduled. */
    if (c->argc > 1) {
        if (c->argc == 2 && !strcasecmp(c->argv[1]->ptr,"schedule")) {
            schedule = 1;
        } else {
            addReply(c,shared.syntaxerr);
            return;
        }
    }

    rdbSaveInfo rsi, *rsiptr;
    rsiptr = rdbPopulateSaveInfo(&rsi);

    if (server.rdb_child_pid != -1) {
        addReplyError(c,"Background save already in progress");
    } else if (server.aof_child_pid != -1) {
        if (schedule) {
            server.rdb_bgsave_scheduled = 1;
            addReplyStatus(c,"Background saving scheduled");
        } else {
            addReplyError(c,
                "An AOF log rewriting in progress: can't BGSAVE right now. "
                "Use BGSAVE SCHEDULE in order to schedule a BGSAVE whenever "
                "possible.");
        }
    } else if (rdbSaveBackground(server.rdb_filename,rsiptr) == C_OK) {
        addReplyStatus(c,"Background saving started");
    } else {
        addReply(c,shared.err);
    }
}

int serverCron(struct aeEventLoop *eventLoop, long long id, void *clientData) {
    ... ...
     /* Start a scheduled BGSAVE if the corresponding flag is set. This is
     * useful when we are forced to postpone a BGSAVE because an AOF
     * rewrite is in progress.
     *
     * Note: this code must be after the replicationCron() call above so
     * make sure when refactoring this file to keep this order. This is useful
     * because we want to give priority to RDB savings for replication. */
    if (server.rdb_child_pid == -1 && server.aof_child_pid == -1 &&
        server.rdb_bgsave_scheduled &&
        (server.unixtime-server.lastbgsave_try > CONFIG_BGSAVE_RETRY_DELAY ||
         server.lastbgsave_status == C_OK))
    {
        rdbSaveInfo rsi, *rsiptr;
        rsiptr = rdbPopulateSaveInfo(&rsi);
        if (rdbSaveBackground(server.rdb_filename,rsiptr) == C_OK)
            server.rdb_bgsave_scheduled = 0;
    }
}
```

由日志触发的情况有以下三种：

1. 按照 'save xxx yy' 配置，在至少修改了 yy 个key后 xxx 秒，触发 rdb save；
2. aof 日志内部机制触发 rewrite；
3. client 调用 BGREWRITEAOF 命令；

在调用 `BGREWRITEAOF` 命令时，会判断当前是否满足开启一个 aof-rewrite 的条件：

+ 当前如果有一个 bgSave 任务在执行，则立即返回。等任务结束后，由 serverCron 启动 aof-rewrite 任务
+ 当前如果有一个 aof-rewrite 任务在执行，则直接返回错误
+ 当前没有 bgSave 任务 和 aof-rewrite 任务，则立即启动一个 aof-rewrite 任务。

整个 aof 任务执行流程如下：

``` mermaid!
graph TB
    start([start])
    exit([end])
    openPipe[open pipes.]
    
    preamble{enable rdb preamble?}
    rdbSave[save data into rdb file.]
    rewriteAof[rewrite the aof file.]
    
    readDiff[save diff data from parent.]
    timeout{save_diff_time >= 1s or <br> no_data_time >= 20ms}
    stopSendingDiff[ask the master stop <br> to sending diffs]
    ackFromParent[read ack from parent.]
    readDiff1[save diff data from parent.]
    scriptFlush[Empty the script cache.]
    start-->openPipe-->fork-.->preamble
    fork-->scriptFlush-->exit
    preamble-->|Yes|rdbSave-->readDiff-->timeout
    preamble-->|No|rewriteAof-->readDiff
    timeout-->|No|readDiff
    timeout-->|Yes|stopSendingDiff-->ackFromParent
    ackFromParent-->readDiff1-.->exit
   
```

启动的任务子进程会将数据先保存在临时文件，当写入完成后再去替换旧的日志文件。当开启 preamble 选项时在 aof-rewrite 时会生成一个 rdb 格式文件（调用 rdbSaveRio 函数），然后会将 diff 内容追加到后面。在上一节讲解 rdbSaveRio 时有提到 `aof-preamble` 字段，该字段标识了当前 rdb 文件是否用于 `aof-rewrite`，即对应上述的情况。aof-rewrite 核心函数为 [rewriteAppendOnlyFileBackground](https://github.com/redis/redis/blob/5.0/src/aof.c#L1569)。

对于以上的 1、2 种情况，都是在开启了持久化由 redis 内部机制自动触发的，其判断触发的逻辑在 serverCron 中，下图中的每个步骤都有一个前提：当前没有 bgSave 和 aof-rewrite 任务在执行：

``` mermaid!
graph LR
    start([Start]) 
    exit([End])

    bgTask{No aof-rewrite and <br> bgSave in progress?}
    schedule{Aof-rewrite has <br> been scheduled?}
    save{change keys > limit_keys <br> and  <br> now - last_save_time > limit_time}
    scheduleAofRewrite[Start a aof-rewrite]
    start-->bgTask-->|No|exit
    bgTask-->|Yes|schedule-->|Yes|scheduleAofRewrite
    scheduleAofRewrite-->exit

    schedule-->|No|save-->|Yes|bgSave[Start a bgSave]-->exit
    rewrite{Growth >= Rewrite-perc <br> and <br> Aof-current-size > Rewrite-min-size}

    save-->|No|rewrite-->|No|exit
    rewrite-->|Yes|aof-rewrite[Start a aof-rewrite]-->exit
```

具体实现如下：

``` C
int serverCron(struct aeEventLoop *eventLoop, long long id, void *clientData) {
    ... ...
    /* Start a scheduled AOF rewrite if this was requested by the user while
     * a BGSAVE was in progress. */
    if (server.rdb_child_pid == -1 && server.aof_child_pid == -1 &&
        server.aof_rewrite_scheduled)
    {
        rewriteAppendOnlyFileBackground();
    }
    ... ...
      /* Check if a background saving or AOF rewrite in progress terminated. */
    if (server.rdb_child_pid != -1 || server.aof_child_pid != -1 ||
        ldbPendingChildren())
    {
       ... ... 
    } else {
        /* If there is not a background saving/rewrite in progress check if
         * we have to save/rewrite now. */
        for (j = 0; j < server.saveparamslen; j++) {
            struct saveparam *sp = server.saveparams+j;

            /* Save if we reached the given amount of changes,
             * the given amount of seconds, and if the latest bgsave was
             * successful or if, in case of an error, at least
             * CONFIG_BGSAVE_RETRY_DELAY seconds already elapsed. */
            if (server.dirty >= sp->changes &&
                server.unixtime-server.lastsave > sp->seconds &&
                (server.unixtime-server.lastbgsave_try >
                 CONFIG_BGSAVE_RETRY_DELAY ||
                 server.lastbgsave_status == C_OK))
            {
                serverLog(LL_NOTICE,"%d changes in %d seconds. Saving...",
                    sp->changes, (int)sp->seconds);
                rdbSaveInfo rsi, *rsiptr;
                rsiptr = rdbPopulateSaveInfo(&rsi);
                rdbSaveBackground(server.rdb_filename,rsiptr);
                break;
            }
        }

        /* Trigger an AOF rewrite if needed. */
        if (server.aof_state == AOF_ON &&
            server.rdb_child_pid == -1 &&
            server.aof_child_pid == -1 &&
            server.aof_rewrite_perc &&
            server.aof_current_size > server.aof_rewrite_min_size)
        {
            long long base = server.aof_rewrite_base_size ?
                server.aof_rewrite_base_size : 1;
            long long growth = (server.aof_current_size*100/base) - 100;
            if (growth >= server.aof_rewrite_perc) {
                serverLog(LL_NOTICE,"Starting automatic rewriting of AOF on %lld%% growth",growth);
                rewriteAppendOnlyFileBackground();
            }
        }
    }
    ... ...
}
```

那么上述由日志触发的 bgSave 能否与 slaves 共享？从代码来看，是无法与 slave 共享的，原因与手动触发一致。至此就解答了第 4 个问题，即由 slave 触发的 bgSave 有条件共享，其他情况 无法共享。

以上所有触发 bgSave 情况在 serverCron 的优先级如下：

1. BGREWRITEAOF command
2. backgroundSaveDoneHandler
3. save config
4. aof-rewrite config
5. replicationCron
6. BGSAVE SCHEDULE command

### Slave 加载 RDB 数据

slave 在将 rdb 数据持久化到本地临时文件中，在完整接收重命名为指定的（缺省为 dump.rdb） rdb file，然后通过 [rdbLoad](https://github.com/redis/redis/blob/5.0/src/rdb.c#L2151) 的方式加载到内存。在加载 rdb file 的过程中，redis 无法执行 flag 不包含 `l` 的命令，此时如果 sub-slave 向其发起 psync handshake 会返回错误：“-LOADING Redis is loading the dataset in memory”。

## Replconf ack 的作用

0. 保证 slave 和 master 之间的链接活性；
1. diskless rdb 数据传输结束后，会等待一个 ack 才开启增量同步；
2. 使用 wait 命令会等待 ack；

## CLIENT PAUSE

master 向 slave 提供主从同步请求的端口，与对普通 client 提供数据服务的端口相同。当开启了`client pause` 时，slave client 也会受到影响：已经完成 hand shake 的 slave client 同步数据过程不受影响，但是未完成 hand shake 的 slave client 会被阻塞，所以该命令要慎重使用。

## Master client

所谓 master client 是指 socket 对端为 master 节点的 client，但该 socket 建立的发起者仍然为 slave 节点。slave 与 master 节点进行握手时会交换 ip 和 port（详情见上一篇），但是 slave 提供的 ip 和 port 对于 master 而言仅仅起到标识作用，在除 failover 情况外，master 不会向 slave 提供的 ip 和 port 主动发起链接。

## FailOver

redis 5.0 的服务模型为**事件驱动模型**，事件的监听和响应在单线程中，这种模型可以天然的实现无锁编程，但是也会带来一些弊端。由于其串行处理模式，当执行某个“耗时” 命令时，可能会导致 redis master 被判定为 `offline` 。

在 redis 初始化的时候，会将 acceptTcpHandler 绑定到所有监听的 （listen port 为server_port） socket fd 的 readable 事件上，会将 acceptUnixHandler 绑定到 unix socket fd 的 readbable 事件上，用于接收 client 链接请求。然后执行 clusterInit，同样将 clusterAcceptHandler 绑定到所有监听的（listen port 为cluster_port = server_port + 10000）socket fd 的 readable 事件上，用于接收其他节点的链接请求。

在接收到链接请求后会将 readQueryFromClient 绑定到 accepted socket fd 上，用于处理对端发送的数据。在执行所有初始化操作后，在 [main](https://github.com/redis/redis/blob/5.0/src/server.c#L4222) 函数中启动事件处理循环，具体实现如下：

``` C
int main(int argc, char **argv) {
    ... ...
    initServer();
    ... ...
    aeMain(server.el);
}


void initServer(void) {
    ... ...
     /* Create the timer callback, this is our way to process many background
     * operations incrementally, like clients timeout, eviction of unaccessed
     * expired keys and so forth. */
    if (aeCreateTimeEvent(server.el, 1, serverCron, NULL, NULL) == AE_ERR) {
        serverPanic("Can't create event loop timers.");
        exit(1);
    }

    /* Create an event handler for accepting new connections in TCP and Unix
     * domain sockets. */
    for (j = 0; j < server.ipfd_count; j++) {
        if (aeCreateFileEvent(server.el, server.ipfd[j], AE_READABLE,
            acceptTcpHandler,NULL) == AE_ERR)
            {
                serverPanic(
                    "Unrecoverable error creating server.ipfd file event.");
            }
    }
    if (server.sofd > 0 && aeCreateFileEvent(server.el,server.sofd,AE_READABLE,
        acceptUnixHandler,NULL) == AE_ERR) serverPanic("Unrecoverable error creating server.sofd file event.");

    ... ...
    if (server.cluster_enabled) clusterInit();
    ... ...
}

void aeMain(aeEventLoop *eventLoop) {
    eventLoop->stop = 0;
    while (!eventLoop->stop) {
        if (eventLoop->beforesleep != NULL)
            eventLoop->beforesleep(eventLoop);
        aeProcessEvents(eventLoop, AE_ALL_EVENTS|AE_CALL_AFTER_SLEEP);
    }
}


void clusterInit(void) {
    ... ...
    if (listenToPort(server.port+CLUSTER_PORT_INCR,
        server.cfd,&server.cfd_count) == C_ERR)
    {
        exit(1);
    } else {
        int j;

        for (j = 0; j < server.cfd_count; j++) {
            if (aeCreateFileEvent(server.el, server.cfd[j], AE_READABLE,
                clusterAcceptHandler, NULL) == AE_ERR)
                    serverPanic("Unrecoverable error creating Redis Cluster "
                                "file event.");
        }
    }
    ... ...
}
```

事件循环处理的流程如下：

``` mermaid!
graph TB
    start([start])
    stop{loop stop?}
    beforeSleep[run proc before sleep]
    exit([end])
    nextTimer[find neartest timer]
    apollWait[apoll wait file events <br> until next timer fired]
    process[process file events]
    processTime[process time events]
    afterSleep[run proc after sleep]
    
    start-->stop-->|Yes|exit
    stop-->|No|beforeSleep-->nextTimer-->apollWait
    apollWait-->afterSleep-->process-->processTime-->stop 
```

事件处理的核心函数是 [aeProcessEvents](https://github.com/redis/redis/blob/5.0/src/ae.c#L358) 函数，采用事件边沿触发机制。通常会先处理 socket fd 可读事件，然后再处理可写事件，即处理客户端请求然后立即应答的模式；也有一些情况需要先处理写事件，再处理读事件，例如：cluster模式下向其他节点发送一个 gossip 消息然后再接收应答。具体实现如下：

``` C
/* Process every pending time event, then every pending file event
 * (that may be registered by time event callbacks just processed).
 * Without special flags the function sleeps until some file event
 * fires, or when the next time event occurs (if any).
 *
 * If flags is 0, the function does nothing and returns.
 * if flags has AE_ALL_EVENTS set, all the kind of events are processed.
 * if flags has AE_FILE_EVENTS set, file events are processed.
 * if flags has AE_TIME_EVENTS set, time events are processed.
 * if flags has AE_DONT_WAIT set the function returns ASAP until all
 * if flags has AE_CALL_AFTER_SLEEP set, the aftersleep callback is called.
 * the events that's possible to process without to wait are processed.
 *
 * The function returns the number of events processed. */
int aeProcessEvents(aeEventLoop *eventLoop, int flags)
{
    int processed = 0, numevents;

    /* Nothing to do? return ASAP */
    if (!(flags & AE_TIME_EVENTS) && !(flags & AE_FILE_EVENTS)) return 0;

    /* Note that we want call select() even if there are no
     * file events to process as long as we want to process time
     * events, in order to sleep until the next time event is ready
     * to fire. */
    if (eventLoop->maxfd != -1 ||
        ((flags & AE_TIME_EVENTS) && !(flags & AE_DONT_WAIT))) {
        int j;
        aeTimeEvent *shortest = NULL;
        struct timeval tv, *tvp;

        if (flags & AE_TIME_EVENTS && !(flags & AE_DONT_WAIT))
            shortest = aeSearchNearestTimer(eventLoop);
        if (shortest) {
            long now_sec, now_ms;

            aeGetTime(&now_sec, &now_ms);
            tvp = &tv;

            /* How many milliseconds we need to wait for the next
             * time event to fire? */
            long long ms =
                (shortest->when_sec - now_sec)*1000 +
                shortest->when_ms - now_ms;

            if (ms > 0) {
                tvp->tv_sec = ms/1000;
                tvp->tv_usec = (ms % 1000)*1000;
            } else {
                tvp->tv_sec = 0;
                tvp->tv_usec = 0;
            }
        } else {
            /* If we have to check for events but need to return
             * ASAP because of AE_DONT_WAIT we need to set the timeout
             * to zero */
            if (flags & AE_DONT_WAIT) {
                tv.tv_sec = tv.tv_usec = 0;
                tvp = &tv;
            } else {
                /* Otherwise we can block */
                tvp = NULL; /* wait forever */
            }
        }

        /* Call the multiplexing API, will return only on timeout or when
         * some event fires. */
        numevents = aeApiPoll(eventLoop, tvp);

        /* After sleep callback. */
        if (eventLoop->aftersleep != NULL && flags & AE_CALL_AFTER_SLEEP)
            eventLoop->aftersleep(eventLoop);

        for (j = 0; j < numevents; j++) {
            aeFileEvent *fe = &eventLoop->events[eventLoop->fired[j].fd];
            int mask = eventLoop->fired[j].mask;
            int fd = eventLoop->fired[j].fd;
            int fired = 0; /* Number of events fired for current fd. */

            /* Normally we execute the readable event first, and the writable
             * event laster. This is useful as sometimes we may be able
             * to serve the reply of a query immediately after processing the
             * query.
             *
             * However if AE_BARRIER is set in the mask, our application is
             * asking us to do the reverse: never fire the writable event
             * after the readable. In such a case, we invert the calls.
             * This is useful when, for instance, we want to do things
             * in the beforeSleep() hook, like fsynching a file to disk,
             * before replying to a client. */
            int invert = fe->mask & AE_BARRIER;

            /* Note the "fe->mask & mask & ..." code: maybe an already
             * processed event removed an element that fired and we still
             * didn't processed, so we check if the event is still valid.
             *
             * Fire the readable event if the call sequence is not
             * inverted. */
            if (!invert && fe->mask & mask & AE_READABLE) {
                fe->rfileProc(eventLoop,fd,fe->clientData,mask);
                fired++;
            }

            /* Fire the writable event. */
            if (fe->mask & mask & AE_WRITABLE) {
                if (!fired || fe->wfileProc != fe->rfileProc) {
                    fe->wfileProc(eventLoop,fd,fe->clientData,mask);
                    fired++;
                }
            }

            /* If we have to invert the call, fire the readable event now
             * after the writable one. */
            if (invert && fe->mask & mask & AE_READABLE) {
                if (!fired || fe->wfileProc != fe->rfileProc) {
                    fe->rfileProc(eventLoop,fd,fe->clientData,mask);
                    fired++;
                }
            }

            processed++;
        }
    }
    /* Check time events */
    if (flags & AE_TIME_EVENTS)
        processed += processTimeEvents(eventLoop);

    return processed; /* return the number of processed file/time events */
}
```

当 server 在接收到 client 发送的完整命令后，**会同步调用对应的 command 实现函数，如果耗时过长会阻塞住其他事件的处理**。例如：在包含大量数据的 redis 数据库中执行 `flushdb` 命令，导致无法响应 cluster 的 gossip 信息，如果阻塞时间超过 cluster-timeout，会被其他节点判定为 FAIL 状态，从而触发主从切换。

flushdbCommand 的主要执行任务就是释放 记录 key-value、key-expire、key-expire-slaves 的 dict 和 记录 key 在 slots 上分布情况 的 struct 占用的内存，具体实现如下：

``` C

/* Remove all keys from all the databases in a Redis server.
 * If callback is given the function is called from time to time to
 * signal that work is in progress.
 *
 * The dbnum can be -1 if all the DBs should be flushed, or the specified
 * DB number if we want to flush only a single Redis database number.
 *
 * Flags are be EMPTYDB_NO_FLAGS if no special flags are specified or
 * EMPTYDB_ASYNC if we want the memory to be freed in a different thread
 * and the function to return ASAP.
 *
 * On success the fuction returns the number of keys removed from the
 * database(s). Otherwise -1 is returned in the specific case the
 * DB number is out of range, and errno is set to EINVAL. */
long long emptyDb(int dbnum, int flags, void(callback)(void*)) {
    int async = (flags & EMPTYDB_ASYNC);
    long long removed = 0;

    if (dbnum < -1 || dbnum >= server.dbnum) {
        errno = EINVAL;
        return -1;
    }

    int startdb, enddb;
    if (dbnum == -1) {
        startdb = 0;
        enddb = server.dbnum-1;
    } else {
        startdb = enddb = dbnum;
    }

    for (int j = startdb; j <= enddb; j++) {
        removed += dictSize(server.db[j].dict);
        if (async) {
            emptyDbAsync(&server.db[j]);
        } else {
            dictEmpty(server.db[j].dict,callback);
            dictEmpty(server.db[j].expires,callback);
        }
    }
    if (server.cluster_enabled) {
        if (async) {
            slotToKeyFlushAsync();
        } else {
            slotToKeyFlush();
        }
    }
    if (dbnum == -1) flushSlaveKeysWithExpireList();
    return removed;
}
```

模拟key-value size 平均为 100 bytes 的场景，在总数据量为 2 GB 场景，分析完全释放的耗时时间：

从 `perf record --call-graph dwarf` 生成的 profil e图上来看，主要的耗时是在执行 emptyDb 函数上：

``` 
Samples: 75K of event 'cycles', Event count (approx.): 45874076225
    main
    aeMain
    aeProcessEvents
        - 89.32% processInputBuffer
            call
            flushdbCommand
          - emptyDb
            - 65.44% dictEmpty
            - 22.05% slotToKeyFlush    
```

其中 `dictEmpty` 是最耗时的部分：

```
    dictEmpty
        - _dictClear
            - 29.04% decrRefCount
                + 10.35% je_free
                   8.83% sdsfree
                + 4.67% zfree
            - 13.65% je_fee
                + 13.06% je_tcache_bin_flush_small
            - 7.61% zfree
                6.74% je_malloc_usable_size
              7.52% sdsfree 
```

其中函数耗时排名中，`sdsfree` 时间占比最高 15.47%，其次是 `je_malloc_usable_size` 函数占比为 11.32%，都是源自 jemalloc package 内部的函数。

简单补充一下关于 perf 的知识，它是基于 hw/sw events、trace point、probe point 采样的性能分析工具，其默认使用 cycles event 作为采样 event，这是由内核映射到特定于硬件的 PMU 事件的通用硬件事件。 对于 Intel，它映射到 UNHALTED_CORE_CYCLES。 在存在 CPU 频率缩放的情况下，此事件不会与时间保持恒定的相关性。Intel 提供了另一个事件，称为 UNHALTED_REFERENCE_CYCLES，但该事件当前不适用于 perf_events。在 AMD 系统上，该事件被映射到 CPU_CLK_UNHALTED 并且该事件也受频率缩放的影响。 在任何 Intel 或 AMD 处理器上，当处理器空闲时，即调用 mwait() 时，循环事件不计算在内。[^1]

## 总结

以上就是在生产过程中遇到的一些问题和原因的分析，redis 5.0 无论代码总量还是模型设计都趋向于就简原则，充分发挥了简洁之美和数据结构之美。阅读 redis 的源码可以发现即使用 C 语言这种低级语言，也可以写出复杂而又精巧的工程，对于软件工程上的设计思路也是极大的启发，例如其事件驱动模型基础上构建的无锁编程设计，（在一定条件下）可以获得不亚于甚至超过多线程服务模型的性能。也对日常生产开发的注意事项有一些帮助，比如 script 的使用和同步，在不同版本下有不同的实现机制；触发 bgSave 的条件和优先级；Failover 的根因分析等等。

## 参考引用

[^1]: perf. Linux kernel profiling with perf. May 5 2015, https://perf.wiki.kernel.org/index.php/Tutorial#Sampling_with_perf_record