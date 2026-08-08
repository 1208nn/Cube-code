import * as vscode from "vscode";

const API_KEY_SECRET = "cube.apiKey";

export async function getApiKey(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  return context.secrets.get(API_KEY_SECRET);
}

export async function setApiKey(
  context: vscode.ExtensionContext,
  key: string,
): Promise<void> {
  await context.secrets.store(API_KEY_SECRET, key);
  await updateContextKeys(context);
}

export async function clearApiKey(
  context: vscode.ExtensionContext,
): Promise<void> {
  await context.secrets.delete(API_KEY_SECRET);
  await updateContextKeys(context);
}

export function getApiUrl(): string {
  return vscode.workspace
    .getConfiguration("cube-oss")
    .get<string>("apiUrl", "");
}

/**
 * Push the upload-mode settings into context keys so the view-title toggle items
 * can show the correct item via `when`. Called both at startup (after menus are
 * registered) and whenever the settings change.
 */
export function syncToggleContextKeys(): void {
  const cfg = vscode.workspace.getConfiguration("cube-oss");
  const convertWebp = cfg.get<boolean>("convertWebp", true);
  const useUuid = cfg.get<boolean>("useUuid", false);
  void vscode.commands.executeCommand(
    "setContext",
    "cube-oss.useUuid",
    useUuid,
  );
  void vscode.commands.executeCommand(
    "setContext",
    "cube-oss.convertWebp",
    convertWebp,
  );
}

export async function updateContextKeys(
  context: vscode.ExtensionContext,
): Promise<void> {
  const key = await context.secrets.get(API_KEY_SECRET);
  await vscode.commands.executeCommand(
    "setContext",
    "cube-oss.hasApiKey",
    !!key,
  );
}
