import {
    CancellationToken,
    ExtensionContext,
    ProcessExecution,
    ProviderResult,
    Task,
    TaskDefinition,
    TaskProvider,
    workspace,
    Disposable,
    tasks
} from "vscode";
import { MrubyVersion } from "../versions";
import * as tempy from "tempy";
import * as fs from "fs";
import { createHash } from "crypto";
import * as path from "path";
import * as glob from "glob";
import { promisify } from "util";

export type MrbcEndianness = "little" | "big";

export interface MrbcTaskDefinition extends TaskDefinition
{
    version?: MrubyVersion;
    watch?: boolean;
    output?: string;
    debug?: boolean;
    symbol?: string;
    endian?: MrbcEndianness;
    include?: string | string[];
    exclude?: string | string[];
    verbose?: boolean;
}

export class MrbcTaskProvider implements TaskProvider, Disposable
{
    /**
     * Task type for Mrbc
     */
    static readonly type = "mrbc";

    /**
     * Temporary directory for passing task data
     */
    private readonly tempDir: string;

    /**
     * Construct and register task provider.
     * @param context 
     */
    static activate(context: ExtensionContext)
    {
        const self = new this(context);
        context.subscriptions.push(
            self,
            tasks.registerTaskProvider(this.type, self)
        );
    }

    /**
     * Construct mrbc task provider.
     * @param context Extension context
     */
    private constructor(readonly context: ExtensionContext)
    {
        this.tempDir = tempy.directory();
    }

    /**
     * Dispose object.
     */
    async dispose(): Promise<void>
    {
        try {
            const files = await promisify(glob)(`${this.tempDir}/*.opt`);
            files.forEach((file) => {
                fs.unlinkSync(file);
            });
            fs.rmdirSync(this.tempDir);
        } catch (error) {
            console.warn("Error detected during cleanup:", error);
        }
    }

    /**
     * Provides tasks.
     * @param token A cancellation token.
     * @return an array of tasks
     */
    async provideTasks(token?: CancellationToken): Promise<Task[]>
    {
        const kinds: TaskDefinition[] = (workspace.getConfiguration("tasks").get("tasks") || []);
        const relatedKinds: MrbcTaskDefinition[] = kinds.filter((kind) => kind.type === MrbcTaskProvider.type);
        return relatedKinds.map((kind) => {
            const options: String[] = [];
            if (kind.watch) {
                options.push("Watch mode");
            }
            if (kind.debug) {
                options.push("Debug info");
            }
            if (kind.symbol) {
                options.push("C language output");
            }
            if (kind.endian) {
                options.push(`${kind.endian.replace(/^./, (c) => c.toUpperCase())} endian`);
            }
            const info = (options.length > 0) ? ` (${options.join(", ")})` : "";
            return this.resolveTask(new Task(
                kind,
                `Compile with mruby${info}`,
                "mruby"
            ), token) as Task;
        });
    }

    /**
     * Resolves a task that has no [`execution`](#Task.execution) set. Tasks are
     * often created from information found in the `tasks.json`-file. Such tasks miss
     * the information on how to execute them and a task provider must fill in
     * the missing information in the `resolveTask`-method. This method will not be
     * called for tasks returned from the above `provideTasks` method since those
     * tasks are always fully resolved. A valid default implementation for the
     * `resolveTask` method is to return `undefined`.
     *
     * @param task The task to resolve.
     * @param token A cancellation token.
     * @return The resolved task
     */
    resolveTask(task: Task, token?: CancellationToken): ProviderResult<Task>
    {
        if (task.definition.type !== MrbcTaskProvider.type) {
            return;
        }

        if (task.execution) {
            console.log("task.execution exists", task.execution);
            return;
        }

        // Get target js file
        const target = this.context.asAbsolutePath("out/runner/mrbcRunner.js");
        task.problemMatchers = [MrbcTaskProvider.type];

        // Create spec file to pass arguments
        const kind = task.definition as MrbcTaskDefinition;
        const args: string[] = [];
        if (kind.version) {
            args.push("--mruby-version", kind.version);
        }
        if (kind.watch) {
            task.isBackground = true;
            args.push("--watch");
        }
        if (kind.debug) {
            args.push("-g");
        }
        if (kind.symbol) {
            args.push(`-B${kind.symbol}`)
        }
        if (kind.endian === "little") {
            args.push("-e");
        } else if (kind.endian === "big") {
            args.push("-E");
        }
        if (kind.verbose) {
            args.push("-v");
        }
        if (kind.output) {
            args.push("--output", kind.output);
        }
        if (kind.include instanceof Array) {
            args.push("--include", ...kind.include);
        } else if (kind.include) {
            args.push("--include", kind.include);
        } else {
            args.push("--include", "**/*.rb");
        }
        if (kind.exclude instanceof Array) {
            args.push("--exclude", ...kind.exclude);
        } else if (kind.exclude) {
            args.push("--exclude", kind.exclude);
        }
        const spec = args.join("\n");
        const specFile = path.join(
            this.tempDir,
            `${createHash("md5").update(spec).digest("hex")}.opt`
        );
        fs.writeFileSync(specFile, spec);

        // Get runner (to override ELECTRON_RUN_AS_NODE variable)
        let runner: string;
        if (process.platform === "win32") {
            runner = this.context.asAbsolutePath("lib/run_as_node.cmd");
        } else {
            runner = this.context.asAbsolutePath("lib/run_as_node.sh");
            const stat = fs.statSync(runner);
            if ((stat.mode & 0o111) !== 0o111) {
                // chmod +x to ensure executable
                fs.chmodSync(runner, stat.mode | 0o111);
            }
        }

        // Set execution of task
        task.execution = new ProcessExecution(
            runner, [process.argv0, target, `@-${specFile}`]
        );
        return task;
    }
}