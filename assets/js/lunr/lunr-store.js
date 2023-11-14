var store = [{
        "title": "Computer_boundary",
        "excerpt":"# Computer boundary 自从第三次工业革命后，信息时代的到来使得计算机成为了人们生活中不可或缺的生产工具，从硬件性能上可以划分为以下几种：超大型计算机（超算，多用于大型科研项目进行海量的计算，其主要侧重于计算尤其是浮点数计算）、大型计算机（主机、服务器，多用于公司生产，运行线上服务和数据库，有强大的IO处理能力）、微型计算机（台式机、笔记本、手机，多用于日常办公和娱乐）。单片机也可以划分为微型计算机，它属于一种用于工业控制的特种计算机。 虽然它们的用途不同，但底层的架构和原理都是相同的，都遵循着（广义上的）冯.诺依曼体系结构，运行的过程都符合图灵机的定义。所以从某种意义上来讲，它们拥有相同的能力边界。有些问题用微型计算机解决不了，同样用大型计算机也解决不了。在使用一种工具、一款软件甚至某项学科时，如果充分了解其边界能力，就可以避免我们做很多无用的尝试。突破边界让人兴奋，可从效率的角度上来讲，事先划定好边界更能提高生产。 ## Math & CS 数学（math）属于形式科学，是研究数量、结构、变化、空间以及信息等概念的一门学科，它被人们称之为自然科学的皇后。计算机科学（computer sceince，缩写cs）与数学是紧密相关，当开发者在使用计算机去解决一个问题的时候一定会去寻找对应的数学模型，其背后一定符合某种数学原理。即便在与数学很“遥远”的业务开发也是如此，代码中无数的 `if` 和 `else` 就是对数学中逻辑学的简单应用。 ### 数学不是万能的 在人们的生产生活中存在着无数个问题，如果把世界上所有问题看作一个集合 S，数学能够覆盖和描述的只是其中一小部分。有很多问题都不属于可计算的问题，例如：为何已经曝光的电信诈骗手法，还是会有人不断的上当受骗？为何同样的礼物送给女友，前一次高兴后一次却生气？ 以上的例子给出的界限都比较模糊，而早在1930年的时候，哥德尔就证明了部分数学公理（蕴含皮亚诺公理体系[2]）不可能既是完备的，又是一致的，即：公理范围内存在命题 `P` 为真，但无法证明的情况。哥德尔不完备定理的提出，让人们意识到数学的方法并不是万能的，下面是哥德尔不完备定理的内容： ``` TheoremVI: For every ω-consistent primitive recursive class κ of formulae, there is aprimitive recursive class-sign r , such that neither forall(v,r) nornot(forall(v,r)) belongs to Conseq(κ) (where v...","categories": [],
        "tags": [],
        "url": "/computer_boundary/",
        "teaser": null
      },{
        "title": "Design_pattern",
        "excerpt":"# Design Pattern 23 classification and list ## Creational patterns ### Abstract factory 抽象工厂模式，提供一个用于创建相关或依赖对象族的接口，而无需指定其具体类。 **使用场景**：当一个场景需要引入多个接口，尤其是针对不同资源要绑定不同的对象时。例如：一个`player`加入战场的时候要分配装备，而且不同`阵营`的`player` 分配的装备型号不同。 ```mermaid! classDiagram class Factory { CreateTank() Tank CreateGun() Gun } > Factory class Tank{ Run() Fire() } > Tank class Gun{ Shoot() } > Gun class sovietFactory{ CreateTank() Tank CreateGun() Gun } class t34...","categories": [],
        "tags": [],
        "url": "/design_pattern/",
        "teaser": null
      },{
        "title": "Redis_psync_protocol",
        "excerpt":"# Redis psync protocol redis老版本的同步协议是 `SYNC`，因为它不支持部分同步所以被`PSYNC`代替，发展出了 `psync1`协议。后续为优化由 `failover` 带来的不必要`full Resynchronization`，发展出了 `psync2` 协议。下面的内容是基于 `redis 5.0` 版本，剖析一下 `psync2` 协议的实现。 ## replication handshake slave 与 master 之前发起同步的过程称为 **replication handshake**， 在 `slave node` 的 [replicationCron](https://github.com/redis/redis/blob/5.0/src/replication.c#L2578) 任务（每秒调用一次）中会调用 `connectWithMaster -> registry file event[syncWithMaster -> slaveTryPartialResynchronization]` 函数与 `master node` 完成 `replication handshake` 过程，具体的握手流程实现在[syncWithMaster](https://github.com/redis/redis/blob/5.0/src/replication.c#L1643)函数中。下面展示的是 `slave node`进入 `REPL_STATE_SEND_PSYNC`状态后的交互流程，在此之前，`slave` 和...","categories": [],
        "tags": [],
        "url": "/redis_psync_protocol/",
        "teaser": null
      },{
        "title": "Redis_psync_protocol(1)",
        "excerpt":"# Redis psync protocol(续) 在上一篇 [redis psync protocol](https://saffraan.github.io/redis_psync_protocol/) 中详细的阐述了 psync 协议的交互流程和实现细节，本文主要是针对命令同步的细节和生产实践中遇到的场景进行一些补充。文中代码部分可以忽略，直接看相关结论。 ## 命令同步 在 redis 的源码中包含多种 command flag，利用这些 flag 来标识 command 的属性： + r(读)：读取数据，不会修改 key 数据； + w(写)：写入数据，可能会修改 key 数据； + m(内存)：可能会增长内存使用率，在 out of memory 时不允许使用； + a(管理)：管理命令，例如 SHUTDOWN、SAVE 命令； + p(发布订阅)：发布订阅相关的命令； + f(强制同步)：无论是否修改 data set 都需要同步给 slave； + s(非script)：在script中不支持的命令；...","categories": [],
        "tags": [],
        "url": "/redis_psync_protocol(1)/",
        "teaser": null
      },{
        "title": "Set_benchmark_analyse",
        "excerpt":"# 记一次测试分析(开启 pipeline 时 slave 对 SET 耗时影响) ## 背景介绍 在工作过程中，测试同事反馈在如下 case 中 redis 的 `get` 指令性能要明显优于 `set` 指令性能： ``` shell redis-benchmark -h $IP -p $PORT -a $PASSWD -r 4000000 -n 5000000 -t set,get -d 500 -c 500 -P 16 ...... 78143.31 requests per second // set ...... 175389.38 requests...","categories": [],
        "tags": [],
        "url": "/set_benchmark_analyse/",
        "teaser": null
      },{
        "title": "Dns",
        "excerpt":"DNS–域名解析系统 简介 DNS（domain name system） 是互联网的重要基础设施，它的作用很简单–把域名（domain name）解析为对应的 IP 地址。在互联网初期时网络主机有限，大家互相记住 IP 地址就好了，但是随着网络主机的增多，纯靠 IP 地址记录对用户不太友好，使用字符串来标识服务器地址更加方便记忆，于是主机名就诞生了。最开始主机名和IP地址之间的映射关系是通过一个简单的 host.txt 文件维护，每天晚上所有主机都从一个维护此文件的站点取回 host.txt。然而随着主机数量不断的增加，这个方案就愈发显得简陋且脆弱：首先这个文件会变得越来越大，其次主机名称冲突会越来越频繁。 为了解决这一问题，DNS 被发明了出来，在 RFC 1034、1035、2181 中给出了 DNS 的定义，后来又有其他文档对其进行阐述。但无论如何发展，它的核心功能没有变化：将域名转化为 ip 地址。 DNS 名字空间 每个城市都有一些常见的街道名如：春风路、南京路等等，如果只用街道名是无法区别的，但是前面加上所属行政区域和城市名称，就可以确定具体地址。域名就类似邮政系统中的地址，它是分层次的，在域基础上去分割子域名，在同一个域下每个子域名要保证唯一性，不同域下的子域名可以重复。对于 internet ，命名层次的顶级由一个专门的组织负责管理– ICANN (Internet Corporation for Assigned Names and Numbers, Internet 名字与数字地址分配机构)，以 www.baidu.com 为例，com 就是最顶级的域名。 顶级域名（TOP-Level）分为两种类型：通用的和国家或地区的，常见的通用域名如下： com: 企业、商业，这是我们最常见的顶级域名； edu: 教育，各个高校站点常用的域名； gov: 政府机关常用的域名；...","categories": [],
        "tags": [],
        "url": "/dns/",
        "teaser": null
      }]
