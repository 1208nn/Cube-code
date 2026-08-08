import * as vscode from 'vscode';

const API_KEY_SECRET = 'cube.apiKey';

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
	return context.secrets.get(API_KEY_SECRET);
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
	await context.secrets.store(API_KEY_SECRET, key);
	await updateContextKeys(context);
}

export async function clearApiKey(context: vscode.ExtensionContext): Promise<void> {
	await context.secrets.delete(API_KEY_SECRET);
	await updateContextKeys(context);
}

export function getApiUrl(): string {
	return vscode.workspace.getConfiguration('cube').get<string>('apiUrl', '');
}

export async function updateContextKeys(context: vscode.ExtensionContext): Promise<void> {
	const key = await context.secrets.get(API_KEY_SECRET);
	await vscode.commands.executeCommand('setContext', 'cube.hasApiKey', !!key);
}
