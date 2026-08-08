import * as vscode from 'vscode';
import { CubeClient } from './api';
import { registerCommands } from './commands';
import { CubeFileSystemProvider } from './fsProvider';
import { getApiKey, getApiUrl, updateContextKeys } from './state';
import { CubeTreeProvider } from './tree';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const client = new CubeClient(getApiUrl, () => getApiKey(context));

	const tree = new CubeTreeProvider(client, async () => !!(await getApiKey(context)));
	const fsProvider = new CubeFileSystemProvider(client, (bucket, location) =>
		tree.invalidate(bucket, location),
	);

	context.subscriptions.push(
		vscode.window.createTreeView('cubeExplorer', {
			treeDataProvider: tree,
			showCollapseAll: true,
		}),
		vscode.workspace.registerFileSystemProvider('cube', fsProvider, { isCaseSensitive: true }),
		...registerCommands({ context, client, tree }),
		context.secrets.onDidChange(() => {
			void updateContextKeys(context).then(() => tree.refresh());
		}),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration('cube.apiUrl')) {
				fsProvider.invalidateAll();
				tree.refresh();
			}
		}),
	);

	await updateContextKeys(context);
}

export function deactivate() {}
