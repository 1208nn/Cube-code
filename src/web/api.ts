export interface FileMeta {
  name: string;
  type?: "dir" | "image";
  size?: number;
  last_modified?: string;
  object_key?: string;
}

interface CommonRespWrap<T> {
  code: number;
  msg: string;
  data: T;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export class AuthError extends Error {
  constructor(message = "Invalid or missing API key") {
    super(message);
    this.name = "AuthError";
  }
}

export class ConfigError extends Error {
  constructor(message = "cube.apiUrl is not configured") {
    super(message);
    this.name = "ConfigError";
  }
}

const OK_CODE = 200;

export class CubeClient {
  constructor(
    private readonly getApiUrl: () => string,
    private readonly getKey: () => Promise<string | undefined>,
  ) {}

  private baseUrl(): string {
    const url = this.getApiUrl().trim();
    if (!url) {
      throw new ConfigError();
    }
    return url.endsWith("/") ? url : url + "/";
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const key = await this.getKey();
    if (!key) {
      throw new AuthError();
    }
    const headers = new Headers(init?.headers);
    headers.set("Key", key);

    let resp: Response;
    try {
      resp = await fetch(new URL(path, this.baseUrl()), { ...init, headers });
    } catch (e) {
      throw new ConfigError(
        `Network error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (resp.status === 401 || resp.status === 403) {
      throw new AuthError();
    }
    const wrap = (await resp.json()) as CommonRespWrap<T>;
    if (wrap.code !== OK_CODE) {
      throw new ApiError(
        wrap.msg || `Request failed (code ${wrap.code})`,
        wrap.code,
      );
    }
    return wrap.data;
  }

  async listBuckets(): Promise<string[]> {
    const data = await this.request<{ bucket_list: string[] }>("api/buckets");
    return data.bucket_list ?? [];
  }

  async listFiles(bucket: string, location: string): Promise<FileMeta[]> {
    const params = new URLSearchParams({ bucket, location });
    const data = await this.request<{ file_list: FileMeta[] }>(
      `api/files?${params}`,
    );
    return data.file_list ?? [];
  }

  async upload(
    bucket: string,
    location: string,
    fileName: string,
    data: Uint8Array,
    opts: { convertWebp?: boolean; useUuid?: boolean } = {},
  ): Promise<void> {
    const form = new FormData();
    form.append("file", new Blob([data as BlobPart]), fileName);
    form.append("bucket", bucket);
    form.append("location", location);
    form.append("convert_webp", opts.convertWebp ? "true" : "false");
    form.append("use_uuid", opts.useUuid ? "true" : "false");
    await this.request<unknown>("api/upload", { method: "POST", body: form });
  }

  async delete(bucket: string, objectKey: string): Promise<void> {
    const form = new FormData();
    form.append("bucket", bucket);
    form.append("object_key", objectKey);
    await this.request<unknown>("api/delete", { method: "DELETE", body: form });
  }

  /** Public (unauthenticated) file URL. */
  fileUrl(bucket: string, objectKey: string): string {
    return `${this.baseUrl()}files/${encodeURIComponent(bucket)}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Public (unauthenticated) image thumbnail URL. */
  thumbnailUrl(bucket: string, objectKey: string): string {
    return `${this.baseUrl()}thumbnails/${encodeURIComponent(bucket)}/${objectKey.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Fetch raw bytes of an object via its public file URL. */
  async download(bucket: string, objectKey: string): Promise<Uint8Array> {
    let resp: Response;
    try {
      resp = await fetch(this.fileUrl(bucket, objectKey));
    } catch (e) {
      throw new Error(
        `Network error while downloading: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!resp.ok) {
      throw new ApiError(`Download failed (HTTP ${resp.status})`, resp.status);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }
}
