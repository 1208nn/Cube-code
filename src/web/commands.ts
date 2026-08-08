import * as vscode from 'vscode';
import { ApiError, AuthError, ConfigError, CubeClient } from './api';
import { clearApiKey, getApiUrl, setApiKey } from './state';
import { CubeNode, CubeTreeProvider, nodeKey, nodeUri } from './tree';

type CommandFn = (...args: any[]) => unknown;

/** Wrap a command body with unified error handling UX. */
function runSafely(fn: CommandFn): CommandFn {
	return async (...args: any[]) => {
		try {
			return await fn(...args);
		} catch (e) {
			if (e instanceof AuthError) {
				const pick = await vscode.window.showErrorMessage(
					'Cube: invalid or missing API key.',
					'Set API Key',
				);
				if (pick) {
					await vscode.commands.executeCommand('cube.setApiKey');
				}
			} else if (e instanceof ConfigError) {
				const pick = await vscode.window.showErrorMessage(
					`Cube: ${e.message}`,
					'Configure API URL',
				);
				if (pick) {
					await vscode.commands.executeCommand('cube.setApiUrl');
				}
			} else if (e instanceof ApiError) {
				await vscode.window.showErrorMessage(`Cube: ${e.message}`);
			} else {
				await vscode.window.showErrorMessage(`Cube: ${e instanceof Error ? e.message : String(e)}`);
			}
			return undefined;
		}
	};
}

export interface CommandDeps {
	context: vscode.ExtensionContext;
	client: CubeClient;
	tree: CubeTreeProvider;
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	const { context, client, tree } = deps;

	const reg = (name: string, fn: CommandFn) =>
		vscode.commands.registerCommand(name, runSafely(fn));

	return [
		reg('cube.setApiKey', async () => {
			const key = await vscode.window.showInputBox({
				title: 'Cube: Set API Key',
				prompt: 'Enter the API key for your Cube OSS backend',
				password: true,
				ignoreFocusOut: true,
			});
			if (key === undefined) {
				return;
			}
			await setApiKey(context, key.trim());
			tree.refresh();
			await vscode.window.showInformationMessage('Cube: API key saved.');
		}),

		reg('cube.clearApiKey', async () => {
			await clearApiKey(context);
			tree.refresh();
			await vscode.window.showInformationMessage('Cube: API key cleared.');
		}),

		reg('cube.setApiUrl', async () => {
			const url = await vscode.window.showInputBox({
				title: 'Cube: Set API URL',
				prompt: 'Base URL of the Cube OSS backend, e.g. https://oss.example.com',
				value: getApiUrl(),
				ignoreFocusOut: true,
			});
			if (url === undefined) {
				return;
			}
			await vscode.workspace
				.getConfiguration('cube')
				.update('apiUrl', url.trim(), vscode.ConfigurationTarget.Global);
			tree.refresh();
			await vscode.window.showInformationMessage('Cube: API URL saved.');
		}),

		reg('cube.refresh', async () => {
			tree.refresh();
		}),

		reg('cube.uploadFile', async (node?: CubeNode) => {
			let bucket: string | undefined;
			let location = '';
			if (node && node.kind !== 'file') {
				bucket = node.bucket;
				location = node.kind === 'dir' ? node.path.replace(/\/$/, '') : '';
			} else {
				const buckets = await client.listBuckets();
				bucket = await vscode.window.showQuickPick(buckets, {
					title: 'Cube: Upload — choose a bucket',
				});
			}
			if (!bucket) {
				return;
			}

			const uris = await vscode.window.showOpenDialog({
				canSelectMany: true,
				openLabel: 'Upload',
				title: `Upload to ${bucket}${location ? '/' + location : ''}`,
			});
			if (!uris?.length) {
				return;
			}

			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Cube: uploading to ${bucket}`,
					cancellable: false,
				},
				async (progress) => {
					let done = 0;
					for (const uri of uris) {
						const name = uri.path.split('/').pop() ?? 'file';
						progress.report({ message: name, increment: (done / uris.length) * 100 });
						const data = await vscode.workspace.fs.readFile(uri);
						await client.upload(bucket!, location, name, data, {
							convertWebp: false,
							useUuid: false,
						});
						done++;
					}
				},
			);
			tree.invalidate(bucket, location);
			await vscode.window.showInformationMessage(
				`Cube: uploaded ${uris.length} file(s) to ${bucket}${location ? '/' + location : ''}.`,
			);
		}),

		reg('cube.downloadFile', async (node: CubeNode) => {
			if (node?.kind !== 'file') {
				return;
			}
			const target = await vscode.window.showSaveDialog({
				defaultUri: vscode.Uri.file(node.meta.name),
				saveLabel: 'Download',
			});
			if (!target) {
				return;
			}
			const data = await client.download(node.bucket, nodeKey(node));
			await vscode.workspace.fs.writeFile(target, data);
			await vscode.window.showInformationMessage(`Cube: downloaded ${node.meta.name}.`);
		}),

		reg('cube.deleteFile', async (node: CubeNode) => {
			if (node?.kind !== 'file') {
				return;
			}
			const confirm = await vscode.window.showWarningMessage(
				`Delete "${node.meta.name}" from bucket "${node.bucket}"? This cannot be undone.`,
				{ modal: true },
				'Delete',
			);
			if (confirm !== 'Delete') {
				return;
			}
			await client.delete(node.bucket, nodeKey(node));
			const key = nodeKey(node);
			const location = key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '';
			tree.invalidate(node.bucket, location);
			await vscode.window.showInformationMessage(`Cube: deleted ${node.meta.name}.`);
		}),

		reg('cube.copyFileUrl', async (node: CubeNode) => {
			if (node?.kind !== 'file') {
				return;
			}
			await vscode.env.clipboard.writeText(client.fileUrl(node.bucket, nodeKey(node)));
			await vscode.window.showInformationMessage('Cube: file URL copied to clipboard.');
		}),

		reg('cube.openFile', async (node: CubeNode) => {
			if (node?.kind !== 'file') {
				return;
			}
			await vscode.commands.executeCommand('vscode.open', nodeUri(node));
		}),

		reg('cube.previewImage', async (node: CubeNode) => {
			if (node?.kind !== 'file') {
				return;
			}
			const panel = vscode.window.createWebviewPanel(
				'cubeImagePreview',
				node.meta.name,
				vscode.ViewColumn.Beside,
				{ enableScripts: false },
			);
			const src = client.thumbnailUrl(node.bucket, nodeKey(node));
			panel.webview.html = `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src http: https:; style-src 'unsafe-inline';">
<style>body{margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1e1e1e}img{max-width:100%;max-height:100vh}</style>
</head>
<body><img src="${src}" alt="${node.meta.name}"></body>
</html>`;
		}),
	];
}
