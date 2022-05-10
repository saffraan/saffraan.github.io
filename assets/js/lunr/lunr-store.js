var store = [{
        "title": "Computer_boundary",
        "excerpt":"Computer boundary 自从第三次工业革命后，信息时代的到来使得计算机成为了人们生活中不可或缺的生产工具，从硬件性能上可以划分为以下几种：超大型计算机（超算，多用于大型科研项目进行海量的计算，其主要侧重于计算尤其是浮点数计算）、大型计算机（主机、服务器，多用于公司生产，运行线上服务和数据库，有强大的IO处理能力）、微型计算机（台式机、笔记本、手机，多用于日常办公和娱乐）。单片机也可以划分为微型计算机，它属于一种用于工业控制的特种计算机。 虽然它们的用途不同，但底层的架构和原理都是相同的，都遵循着（广义上的）冯.诺依曼体系结构，运行的过程都符合图灵机的定义。所以从某种意义上来讲，它们拥有相同的能力边界。有些问题用微型计算机解决不了，同样用大型计算机也解决不了。在使用一种工具、一款软件甚至某项学科时，如果充分了解其边界能力，就可以避免我们做很多无用的尝试。突破边界让人兴奋，可从效率的角度上来讲，事先划定好边界更能提高生产。 Math &amp; CS 数学（math）属于形式科学，是研究数量、结构、变化、空间以及信息等概念的一门学科，它被人们称之为自然科学的皇后。计算机科学（computer sceince，缩写cs）与数学是紧密相关，当开发者在使用计算机去解决一个问题的时候一定会去寻找对应的数学模型，其背后一定符合某种数学原理。即便在与数学很“遥远”的业务开发也是如此，代码中无数的 if 和 else 就是对数学中逻辑学的简单应用。 数学不是万能的 在人们的生产生活中存在着无数个问题，如果把世界上所有问题看作一个集合 S，数学能够覆盖和描述的只是其中一小部分。有很多问题都不属于可计算的问题，例如：为何已经曝光的电信诈骗手法，还是会有人不断的上当受骗？为何同样的礼物送给女友，前一次高兴后一次却生气？ 以上的例子给出的界限都比较模糊，而早在1930年的时候，哥德尔就证明了部分数学公理（蕴含皮亚诺公理体系[2]）不可能既是完备的，又是一致的，即：公理范围内存在命题 P 为真，但无法证明的情况。哥德尔不完备定理的提出，让人们意识到数学的方法并不是万能的，下面是哥德尔不完备定理的内容： TheoremVI: For every ω-consistent primitive recursive class κ of formulae, there is aprimitive recursive class-sign r , such that neither forall(v,r) nornot(forall(v,r)) belongs to Conseq(κ) (where v is the free variable...","categories": [],
        "tags": [],
        "url": "/computer_boundary/",
        "teaser": null
      },{
        "title": "Design_pattern",
        "excerpt":"Design Pattern 23 classification and list Creational patterns Abstract factory 抽象工厂模式，提供一个用于创建相关或依赖对象族的接口，而无需指定其具体类。 使用场景：当一个场景需要引入多个接口，尤其是针对不同资源要绑定不同的对象时。例如：一个player加入战场的时候要分配装备，而且不同阵营的player 分配的装备型号不同。 调用方不需要了解实例化过程和接口对应的实现类，只要能Tank可以开、Gun可以射击，他只需要找到正确的factory。golang的示例代码如下： type Factory interface{ CreateTank() Tank CreateGun() Gun } type Tank interface{ Fire() Run() } type Gun()interface{ Shot() } type sovietFactory struct{ } func (sf *sovietFactory) CreateTank() Car{ return &amp;t34{ gas: 700 engine: \"t34\" bullet: 50 }...","categories": [],
        "tags": [],
        "url": "/design_pattern/",
        "teaser": null
      },{
        "title": "Redis_psync_protocol",
        "excerpt":"Redis psync protocol redis老版本的同步协议是 SYNC，因为它不支持部分同步所以被PSYNC代替，发展出了 psync1协议。后续为优化由 failover 带来的不必要full Resynchronization，发展出了 psync2 协议。下面的内容是基于 redis 5.0 版本，剖析一下 psync2 协议的实现。 replication handshake slave 与 master 之前发起同步的过程称为 replication handshake， 在 slave node 的 replicationCron 任务（每秒调用一次）中会调用 connectWithMaster -&gt; registry file event[syncWithMaster -&gt; slaveTryPartialResynchronization] 函数与 master node 完成 replication handshake 过程，具体的握手流程实现在syncWithMaster函数中。下面展示的是 slave node进入 REPL_STATE_SEND_PSYNC状态后的交互流程，在此之前，slave 和 master已经依次执行了如下流程： slave...","categories": [],
        "tags": [],
        "url": "/redis_psync_protocol/",
        "teaser": null
      },{
        "title": "Redis_psync_protocol(1)",
        "excerpt":"Redis psync protocol(续) 在上一篇 redis psync protocol 中详细的阐述了 psync 协议的交互流程和实现细节，本文主要是针对命令同步的细节和生产实践中遇到的场景进行一些补充。文中代码部分可以忽略，直接看相关结论。 命令同步 在 redis 的源码中包含多种 command flag，利用这些 flag 来标识 command 的属性： r(读)：读取数据，不会修改 key 数据； w(写)：写入数据，可能会修改 key 数据； m(内存)：可能会增长内存使用率，在 out of memory 时不允许使用； a(管理)：管理命令，例如 SHUTDOWN、SAVE 命令； p(发布订阅)：发布订阅相关的命令； f(强制同步)：无论是否修改 data set 都需要同步给 slave； s(非script)：在script中不支持的命令； l(loading)：在数据库加载数据时允许执行的命令； t(-)：当 slave 具有一些陈旧数据但是不允许使用该数据提供服务时，只有少数命令被允许执行； M(屏蔽monitor)：不会被自动传播给 monitor 的命令； k(ask)： 为此命令执行隐式...","categories": [],
        "tags": [],
        "url": "/redis_psync_protocol(1)/",
        "teaser": null
      },{
        "title": "Set_benchmark_analyse",
        "excerpt":"记一次测试分析(开启 pipeline 时 slave 对 SET 耗时影响) 背景介绍 在工作过程中，测试同事反馈在如下 case 中 redis 的 get 指令性能要明显优于 set 指令性能： redis-benchmark -h $IP -p $PORT -a $PASSWD -r 4000000 -n 5000000 -t set,get -d 500 -c 500 -P 16 ...... 78143.31 requests per second // set ...... 175389.38 requests per second // get...","categories": [],
        "tags": [],
        "url": "/set_benchmark_analyse/",
        "teaser": null
      }]
