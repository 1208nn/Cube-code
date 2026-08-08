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
	prefs: UploadPrefs;
}

interface UploadPrefs {
	convertWebp: boolean;
	useUuid: boolean;
}

/** Extensions the backend can convert to WebP (others are left untouched). */
const WEBP_CONVERTIBLE = /\.(png|jpe?g)$/i;

function isConvertible(name: string): boolean {
	return WEBP_CONVERTIBLE.test(name);
}

async function setPrefContext(prefs: UploadPrefs): Promise<void> {
	await vscode.commands.executeCommand('setContext', 'cube.convertWebp', prefs.convertWebp);
	await vscode.commands.executeCommand('setContext', 'cube.useUuid', prefs.useUuid);
}

export function registerCommands(deps: CommandDeps): vscode.Disposable[] {
	const { context, client, tree, prefs } = deps;

	const reg = (name: string, fn: CommandFn) =>
		vscode.commands.registerCommand(name, runSafely(fn));

	const pickBucket = async (): Promise<string | undefined> => {
		const buckets = await client.listBuckets();
		return vscode.window.showQuickPick(buckets, { title: 'Cube: 选择 bucket' });
	};

	/** Upload local files into bucket/location with progress. */
	const uploadFiles = async (
		bucket: string,
		location: string,
		uris: vscode.Uri[],
	): Promise<void> => {
		await vscode.window.withProgress(
			{
				location: vscode.ProgressLocation.Notification,
				title: `Cube: uploading to ${bucket}${location ? '/' + location : ''}`,
				cancellable: false,
			},
			async (progress) => {
				const step = 100 / uris.length;
				for (const uri of uris) {
					const name = uri.path.split('/').pop() ?? 'file';
					progress.report({ message: name });
					const data = await vscode.workspace.fs.readFile(uri);
					await client.upload(bucket, location, name, data, {
						convertWebp: prefs.convertWebp && isConvertible(name),
						useUuid: prefs.useUuid,
					});
					progress.report({ increment: step });
				}
			},
		);
		tree.invalidate(bucket, location);
		await vscode.window.showInformationMessage(
			`Cube: uploaded ${uris.length} file(s) to ${bucket}${location ? '/' + location : ''}.`,
		);
	};

	const pickLocalFiles = (title: string) =>
		vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Upload', title });

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

		reg('cube.toggleConvertWebp', async () => {
			prefs.convertWebp = !prefs.convertWebp;
			await setPrefContext(prefs);
			await vscode.window.showInformationMessage(
				`Cube: WebP 转换已${prefs.convertWebp ? '开启' : '关闭'}（对 png/jpg/jpeg 生效）`,
			);
		}),

		reg('cube.toggleUseUuid', async () => {
			prefs.useUuid = !prefs.useUuid;
			await setPrefContext(prefs);
			await vscode.window.showInformationMessage(
				`Cube: UUID 重命名已${prefs.useUuid ? '开启' : '关闭'}`,
			);
		}),

		reg('cube.uploadFile', async (node?: CubeNode) => {
			let bucket: string | undefined;
			let location = '';
			if (node && node.kind !== 'file') {
				bucket = node.bucket;
				location = node.kind === 'dir' ? node.path.replace(/\/$/, '') : '';
			} else {
				bucket = await pickBucket();
			}
			if (!bucket) {
				return;
			}

		const uris = await pickLocalFiles(`Upload to ${bucket}${location ? '/' + location : ''}`);
		if (!uris?.length) {
			return;
		}
		await uploadFiles(bucket, location, uris);
	}),

		// Folders materialize on upload (backend has no explicit mkdir): the command
		// asks for a folder name, then uploads chosen files into that location.
		reg('cube.newFolder', async (node?: CubeNode) => {
			let bucket: string | undefined;
			let base = '';
			if (node && node.kind !== 'file') {
				bucket = node.bucket;
				base = node.kind === 'dir' ? node.path.replace(/\/$/, '') : '';
			} else {
				bucket = await pickBucket();
			}
			if (!bucket) {
				return;
			}

			const name = await vscode.window.showInputBox({
				title: 'Cube: New Folder',
				prompt: `在 ${bucket}/${base ? base + '/' : ''} 下新建文件夹（文件夹随上传的文件一起创建）`,
				validateInput: (v) => {
					if (!v.trim()) {
						return '文件夹名不能为空';
					}
					if (/[/\\]/.test(v)) {
						return '文件夹名不能包含 / 或 \\';
					}
					return undefined;
				},
			});
			if (name === undefined) {
				return;
			}
			const location = base ? `${base}/${name.trim()}` : name.trim();

		const uris = await pickLocalFiles(`Upload into new folder ${bucket}/${location}`);
		if (!uris?.length) {
			return;
		}
		await uploadFiles(bucket, location, uris);
	}),

		reg('cube.downloadFile', async (node: CubeNode) => {
			if (node?.kind !== 'file') {
				return;
			}
			const target = await vscode.window.showSaveDialog({
				defaultUri: defaultDownloadUri(node.meta.name),
				saveLabel: 'Download',
			});
			if (!target) {
				return;
			}
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: `Cube: downloading ${node.meta.name}`,
					cancellable: false,
				},
				async () => {
					const data = await client.download(node.bucket, nodeKey(node));
					await vscode.workspace.fs.writeFile(target, data);
				},
			);
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

/**
 * Default download target: configured `cube.downloadDirectory` first (web
 * extensions cannot resolve the OS home dir, so set it to e.g.
 * `C:/Users/you/Downloads`), then the first workspace folder.
 */
function defaultDownloadUri(name: string): vscode.Uri {
	const dir = vscode.workspace
		.getConfiguration('cube')
		.get<string>('downloadDirectory', '')
		.trim();
	if (dir) {
		return vscode.Uri.file(`${dir.replace(/[\\/]+$/, '')}/${name}`);
	}
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder) {
		return vscode.Uri.joinPath(folder.uri, name);
	}
	return vscode.Uri.file(name);
}
