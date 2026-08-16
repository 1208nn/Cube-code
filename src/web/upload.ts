import * as vscode from "vscode";
import { CubeClient } from "./api";
import { CubeTreeProvider } from "./tree";

/** Read upload preferences from workspace configuration. */
export function getPrefs(): { convertWebp: boolean; useUuid: boolean } {
  const cfg = vscode.workspace.getConfiguration("cube-oss");
  return {
    convertWebp: cfg.get<boolean>("convertWebp", true),
    useUuid: cfg.get<boolean>("useUuid", false),
  };
}

/** Build a case-insensitive regex for formats that can be converted to WebP. */
export function webpConvertibleRegex(): RegExp {
  const exts = vscode.workspace
    .getConfiguration("cube-oss")
    .get<string[]>("webpConvertible") ?? [
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".tif",
    ".tiff",
    ".bmp",
  ];
  const parts = exts.map((e) => {
    const ext = e.trim().toLowerCase();
    const dotted = ext.startsWith(".") ? ext : "." + ext;
    return dotted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  return new RegExp(`(${parts.join("|")})$`, "i");
}

/** Upload local URIs into bucket/location with a progress notification. */
export async function uploadFiles(
  client: CubeClient,
  tree: CubeTreeProvider,
  bucket: string,
  location: string,
  uris: vscode.Uri[],
): Promise<void> {
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Cube: uploading to ${bucket}${location ? "/" + location : ""}`,
      cancellable: false,
    },
    async (progress) => {
      const step = 100 / uris.length;
      const { convertWebp, useUuid } = getPrefs();
      const regex = webpConvertibleRegex();
      for (const uri of uris) {
        const name = uri.path.split("/").pop() ?? "file";
        progress.report({ message: name });
        const data = await vscode.workspace.fs.readFile(uri);
        await client.upload(bucket, location, name, data, {
          convertWebp: convertWebp && regex.test(name),
          useUuid,
        });
        progress.report({ increment: step });
      }
    },
  );
  tree.invalidate(bucket, location);
  await vscode.window.showInformationMessage(
    `Cube：已上传 ${uris.length} 个文件到 ${bucket}${location ? "/" + location : ""}。`,
  );
}
