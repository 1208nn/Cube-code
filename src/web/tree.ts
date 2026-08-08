import * as vscode from 'vscode';
import { CubeClient, FileMeta } from './api';

export type CubeNode =
	| { kind: 'bucket'; bucket: string }
	| { kind: 'dir'; bucket: string; path: string }
	| { kind: 'file'; bucket: string; path: string; meta: FileMeta };

/** Object key for a node (files/dirs). Dir keys end with '/'. */
export function nodeKey(node: CubeNode): string {
	if (node.kind === 'bucket') {
		return '';
	}
	return node.path;
}

export function nodeUri(node: CubeNode): vscode.Uri {
	const bucket = node.bucket;
	const key = nodeKey(node).split('/').map(encodeURIComponent).join('/');
	return vscode.Uri.parse(`cube://${encodeURIComponent(bucket)}/${key}`);
}

export class CubeTreeProvider implements vscode.TreeDataProvider<CubeNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<CubeNode | undefined | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private readonly cache = new Map<string, FileMeta[]>();

	constructor(
		private readonly client: CubeClient,
		private readonly hasApiKey: () => Promise<boolean>,
	) {}

	refresh(): void {
		this.cache.clear();
		this._onDidChangeTreeData.fire();
	}

	invalidate(bucket: string, location: string): void {
		this.cache.delete(`${bucket}::${location}`);
		this._onDidChangeTreeData.fire();
	}

	async getChildren(node?: CubeNode): Promise<CubeNode[]> {
		if (!(await this.hasApiKey())) {
			return [];
		}
		if (!node) {
			const buckets = await this.client.listBuckets();
			return buckets.map((bucket) => ({ kind: 'bucket', bucket }));
		}
		if (node.kind === 'file') {
			return [];
		}
		const location = node.kind === 'bucket' ? '' : node.path.replace(/\/$/, '');
		const metas = await this.listFilesCached(node.bucket, location);
		return metas.map((meta) => this.metaToNode(node.bucket, location, meta));
	}

	private async listFilesCached(bucket: string, location: string): Promise<FileMeta[]> {
		const cacheKey = `${bucket}::${location}`;
		let metas = this.cache.get(cacheKey);
		if (!metas) {
			metas = await this.client.listFiles(bucket, location);
			this.cache.set(cacheKey, metas);
		}
		return metas;
	}

	private metaToNode(bucket: string, location: string, meta: FileMeta): CubeNode {
		if (meta.type === 'dir') {
			const path = location ? `${location}/${meta.name}/` : `${meta.name}/`;
			return { kind: 'dir', bucket, path };
		}
		const path = meta.object_key ?? (location ? `${location}/${meta.name}` : meta.name);
		return { kind: 'file', bucket, path, meta };
	}

	getTreeItem(node: CubeNode): vscode.TreeItem {
		switch (node.kind) {
			case 'bucket': {
				const item = new vscode.TreeItem(node.bucket, vscode.TreeItemCollapsibleState.Collapsed);
				item.contextValue = 'bucket';
				item.iconPath = new vscode.ThemeIcon('database');
				return item;
			}
			case 'dir': {
				const name = node.path.replace(/\/$/, '').split('/').pop() ?? node.path;
				const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
				item.contextValue = 'folder';
				item.iconPath = new vscode.ThemeIcon('folder');
				item.resourceUri = nodeUri(node);
				return item;
			}
			case 'file': {
				const isImage = node.meta.type === 'image';
				const item = new vscode.TreeItem(node.meta.name, vscode.TreeItemCollapsibleState.None);
				item.contextValue = isImage ? 'image' : 'file';
				item.iconPath = new vscode.ThemeIcon(isImage ? 'file-media' : 'file');
				item.resourceUri = nodeUri(node);
				if (node.meta.size !== undefined) {
					item.description = formatSize(node.meta.size);
				}
				if (node.meta.last_modified) {
					item.tooltip = `${node.meta.name}\nModified: ${node.meta.last_modified}`;
				}
				item.command = {
					command: 'cube.openFile',
					title: 'Open File',
					arguments: [node],
				};
				return item;
			}
		}
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) {
		return `${bytes} B`;
	}
	const units = ['KB', 'MB', 'GB', 'TB'];
	let size = bytes / 1024;
	let i = 0;
	while (size >= 1024 && i < units.length - 1) {
		size /= 1024;
		i++;
	}
	return `${size.toFixed(1)} ${units[i]}`;
}
