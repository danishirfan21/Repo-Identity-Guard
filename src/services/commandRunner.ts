import * as vscode from "vscode";

const TERMINAL_NAME = "Repo Identity Guard";

let terminal: vscode.Terminal | undefined;

/**
 * Runs a saved command in a visible integrated terminal so the user always
 * sees exactly what ran and its output — Repo Identity Guard never executes
 * saved commands silently or captures their output itself.
 */
export function runSavedCommand(cwd: string, command: string): void {
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal({ name: TERMINAL_NAME, cwd });
  }
  terminal.show();
  terminal.sendText(command, true);
}

export async function copyToClipboard(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
}
