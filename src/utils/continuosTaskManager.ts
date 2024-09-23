/*!
 * Copyright (C) 2023 Lju
 *
 * This file is part of Astra Monitor extension for GNOME Shell.
 * [https://github.com/AstraExt/astra-monitor]
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program. If not, see <https://www.gnu.org/licenses/>.
 */

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import CancellableTaskManager from './cancellableTaskManager.js';

export type ContinuosTaskManagerData = {
    result?: string;
    exit: boolean;
};

type ContinuosTaskManagerListener = (data: ContinuosTaskManagerData) => void;

type FlushOptions = {
    trigger?: string;
    interval?: number;
    idle?: number;
};

type Options = {
    flush: FlushOptions;
    stdin?: boolean;
    script?: boolean;
};

export default class ContinuosTaskManager {
    private currentTask?: CancellableTaskManager<boolean>;
    private command?: string;
    private output: string = '';
    private listeners: Map<any, ContinuosTaskManagerListener> = new Map();

    private options?: Options;
    private timerId?: number;

    public start(command: string, options?: Options) {
        if(this.currentTask) this.currentTask.cancel();
        this.currentTask = new CancellableTaskManager();
        this.command = command;
        this.options = options;
        this.output = '';
        this.currentTask
            .run(this.task.bind(this))
            .catch(() => {})
            .finally(() => {
                this.stop();
            });

        if(this.options?.flush?.interval) {
            this.startTimer();
        }
    }

    private task(): Promise<boolean> {
        return new Promise((resolve, reject) => {
            if(!this.command) {
                reject('No command or script provided');
                return;
            }

            let argv;
            if(this.options?.script) {
                argv = ['bash', '-c', this.command];
            } else {
                try {
                    argv = GLib.shell_parse_argv(this.command);
                    if(!argv[0]) throw new Error('Invalid command');
                    argv = argv[1];
                } catch(e: any) {
                    reject(`Failed to parse command: ${e.message}`);
                    return;
                }
            }

            if(!argv) {
                reject('Failed to parse command');
                return;
            }

            let flags = Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE;
            if(this.options?.stdin) {
                flags |= Gio.SubprocessFlags.STDIN_PIPE;
            }

            // Create a new subprocess
            const proc = new Gio.Subprocess({ argv, flags });

            if(!proc) {
                reject('Failed to create subprocess');
                return;
            }

            // Initialize the subprocess
            try {
                const init = proc.init(this.currentTask?.cancellable || null);
                if(!init) {
                    reject('Failed to initialize subprocess');
                    return;
                }
            } catch(e: any) {
                // Handle errors in subprocess initialization
                reject(`Failed to initialize subprocess: ${e.message}`);
                return;
            }

            this.currentTask?.setSubprocess(proc);

            const stdinStream = proc.get_stdin_pipe();
            const stdoutStream = new Gio.DataInputStream({
                baseStream: proc.get_stdout_pipe(),
                closeBaseStream: true,
            });

            this.readOutput(resolve, reject, stdoutStream, stdinStream);
        });
    }

    private readOutput(
        resolve: (value: boolean | PromiseLike<boolean>) => void,
        reject: (reason?: any) => void,
        stdout: Gio.DataInputStream,
        stdin: Gio.OutputStream | null
    ) {
        stdout.read_line_async(
            GLib.PRIORITY_LOW,
            this.currentTask?.cancellable || null,
            (stream, result) => {
                try {
                    const [line] = stream.read_line_finish_utf8(result);

                    if(line !== null) {
                        if(this.output.length) this.output += '\n' + line;
                        else this.output += line;

                        if(this.options?.flush?.idle) {
                            this.startTimer();
                        }

                        if(
                            this.options?.flush?.trigger &&
                            line.includes(this.options.flush.trigger)
                        ) {
                            this.listeners.forEach((callback, _subject) => {
                                callback({ result: this.output, exit: false });
                            });
                            this.output = '';
                        }
                        this.readOutput(resolve, reject, stdout, stdin);
                    } else {
                        this.stopTimer();
                        this.listeners.forEach((callback, _subject) => {
                            callback({ exit: true });
                        });
                        resolve(true);
                    }
                } catch(e: any) {
                    this.stopTimer();
                    this.listeners.forEach((callback, _subject) => {
                        callback({ exit: true });
                    });
                    resolve(false);
                }
            }
        );
    }

    public listen(subject: any, callback: ContinuosTaskManagerListener) {
        this.listeners.set(subject, callback);
    }

    public unlisten(subject: any) {
        this.listeners.delete(subject);
    }

    private startTimer() {
        this.stopTimer();

        const time = this.options?.flush?.idle ?? this.options?.flush?.interval ?? 1000;
        this.timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, time, () => {
            if(this.output.length > 0) {
                this.listeners.forEach((callback, _subject) => {
                    callback({ result: this.output, exit: false });
                });
                this.output = '';
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    private stopTimer() {
        if(this.timerId !== undefined) {
            GLib.source_remove(this.timerId);
            this.timerId = undefined;
        }
    }

    public stop() {
        this.stopTimer();

        if(this.currentTask) {
            this.currentTask.cancel();
        }
        this.currentTask = undefined;
    }

    public get isRunning() {
        return this.currentTask?.isRunning || false;
    }
}
