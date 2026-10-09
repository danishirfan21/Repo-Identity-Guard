import Module from "node:module";

/**
 * `src/ui/SidebarProvider.ts` (correctly) imports the real `vscode`
 * module, which only exists inside the VS Code Extension Host — there is
 * no shim for it anywhere else in this codebase, which is why no test
 * before this one exercised `SidebarProvider.ts` (or `extension.ts`)
 * directly; every other test that touches `vscode`-adjacent behavior
 * does so through a module that only ever imports `vscode`'s TYPES
 * (`import type * as vscode from "vscode"`, erased at compile time —
 * see `src/storage/memoryStore.ts`).
 *
 * `SidebarProvider.ts`'s only RUNTIME (non-type-only) use of `vscode` is
 * `vscode.Uri.joinPath(...)`, called from `resolveWebviewView`/`getHtml`
 * to build the webview's asset URIs. `installVscodeStub` installs the
 * smallest possible stand-in for exactly that — enough for
 * `RepoIdentitySidebarProvider` to load and run for real in a plain
 * `node:test` process, with no VS Code host and no new dependency. The
 * host-level dispatch tests in `sidebarProviderHostRace.test.ts` need
 * nothing else from `vscode`: they never call anything that would touch
 * `vscode.window`/`vscode.workspace`/`vscode.commands` (those live in
 * `extension.ts`, which this stub does NOT attempt to make loadable —
 * see that test file's own doc comment on this limitation).
 *
 * Scoped to resolving the literal module id `"vscode"`; every other
 * `require` is passed straight through to Node's real resolver.
 * Idempotent and side-effect-only on import — safe to import from more
 * than one test file in the same process (`node --test` runs every
 * compiled test file in one process via `scripts/run-tests.js`).
 */

interface StubUri {
  fsPath: string;
  toString(): string;
}

function makeUri(fsPath: string): StubUri {
  return { fsPath, toString: () => `stub-uri:${fsPath}` };
}

export const VSCODE_STUB = {
  Uri: {
    file: (fsPath: string): StubUri => makeUri(fsPath),
    joinPath: (base: StubUri | undefined, ...parts: string[]): StubUri => makeUri([base?.fsPath ?? String(base), ...parts].join("/")),
  },
};

type NodeModuleLoad = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;

const moduleWithLoad = Module as unknown as { _load: NodeModuleLoad };
const originalLoad = moduleWithLoad._load;
let installed = false;

if (!installed) {
  installed = true;
  moduleWithLoad._load = function patchedLoad(this: unknown, request: string, parent: unknown, isMain: boolean): unknown {
    if (request === "vscode") return VSCODE_STUB;
    return originalLoad.call(this, request, parent, isMain);
  };
}
