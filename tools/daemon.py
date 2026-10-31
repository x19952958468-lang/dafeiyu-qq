#!/usr/bin/env python3
"""把命令 daemonize：双 fork + setsid，脱离当前会话进程组，父会话退出后仍存活。

    python3 tools/daemon.py <stdout日志路径> <命令> [参数...]

例：python3 tools/daemon.py data/bot.log node src/index.js
"""
import os
import sys


def main():
    if len(sys.argv) < 3:
        print("用法: daemon.py <log路径> <命令> [参数...]")
        return 1
    log_path, cmd = sys.argv[1], sys.argv[2:]
    workdir = os.getcwd()

    pid = os.fork()
    if pid > 0:
        print(pid)  # 第一次 fork 的父进程立刻返回，把子进程 pid 打出来
        return 0

    os.setsid()  # 脱离控制终端与会话

    pid2 = os.fork()
    if pid2 > 0:
        os._exit(0)  # 中间进程退出，孙进程被 init 收养

    os.chdir(workdir)
    os.umask(0o022)

    fd = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    os.dup2(fd, 1)
    os.dup2(fd, 2)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    for f in (fd, devnull):
        if f > 2:
            try:
                os.close(f)
            except OSError:
                pass

    try:
        os.execvp(cmd[0], cmd)
    except Exception as e:  # noqa: BLE001
        os.write(2, f"exec 失败: {e}\n".encode())
        os._exit(127)


if __name__ == "__main__":
    sys.exit(main())
