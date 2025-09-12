import fs from "node:fs";
import path from "node:path";

import { TypedEmitter } from "tiny-typed-emitter";
import PQueue from "p-queue";
import axios, { AxiosInstance } from "axios";
import { md5File } from "./utils.js";

// 上传器事件接口
interface UploaderEvents {
  start: () => void;
  completed: (response: { fileId: string; filename: string }) => void;
  progress: (response: {
    event: "init" | "preupload" | "uploading" | "complete" | "merging";
    progress: number;
    data: {
      loaded: number;
      total: number;
      [key: string]: any;
    };
  }) => void;
  error: (error: Error) => void;
  cancel: () => void;
  debug: (data: any) => void;
}

// 上传分片任务接口
interface UploadChunkTask {
  filePath: string;
  start: number;
  chunkSize: number;
  size: number;
  token: string;
  uploadId: string;
  chunk: number;
  chunks: number;
  controller: AbortController;
  status?: "pending" | "completed" | "running" | "error" | "abort";
}

/**
 * 123云盘上传类
 */
export class Uploader {
  private status:
    | "pending"
    | "running"
    | "paused"
    | "completed"
    | "error"
    | "cancel" = "pending";
  private queue: PQueue;
  private emitter = new TypedEmitter<UploaderEvents>();
  private progress: { [key: string]: number } = {};
  private chunkTasks: { [key: number]: UploadChunkTask } = {};
  private size: number = 0;
  private options: {
    concurrency: number;
    retryTimes: number;
    retryDelay: number;
    limitRate: number;
    apiBaseUrl: string;
    duplicate: number;
    pollInterval: number;
    pollMaxTimes: number;
  };
  private request: AxiosInstance;
  private chunkSize: number = 4 * 1024 * 1024;

  // 事件监听器
  on: TypedEmitter<UploaderEvents>["on"];
  once: TypedEmitter<UploaderEvents>["once"];
  off: TypedEmitter<UploaderEvents>["off"];

  // 文件信息
  private filePath: string;
  private filename: string;
  private token: string;
  private parentFileID: string;

  /**
   * 构造函数
   * @param filePath 文件路径
   * @param token 访问令牌
   * @param parentFileID 父目录ID，默认为根目录(0)
   * @param options 选项
   * @param duplicate 是否重复上传，默认为1
   * @param concurrency 并发数，默认为3
   * @param retryTimes 重试次数，默认为3
   * @param retryDelay 重试延迟，默认为3000ms
   * @param limitRate 限速，默认为0
   * @param pollInterval 轮询间隔，默认为2000ms
   * @param pollMaxTimes 最大轮询次数，默认为30次（约1分钟）
   */
  constructor(
    filePath: string,
    token: string,
    parentFileID: string = "0",
    options: {
      concurrency?: number;
      retryTimes?: number;
      retryDelay?: number;
      limitRate?: number;
      duplicate?: number;
      pollInterval?: number;
      pollMaxTimes?: number;
    } = {}
  ) {
    this.options = Object.assign(
      {
        concurrency: 3,
        retryTimes: 3,
        retryDelay: 3000,
        limitRate: 0,
        apiBaseUrl: "https://open-api.123pan.com",
        duplicate: 1,
        pollInterval: 2000, // 默认2秒轮询一次
        pollMaxTimes: 30, // 默认最多轮询30次
      },
      options
    );

    this.filePath = filePath;
    this.filename = path.basename(filePath);
    this.token = token;
    this.parentFileID = parentFileID;
    this.progress = {};
    this.queue = new PQueue({ concurrency: this.options.concurrency });

    // 绑定事件发射器
    this.on = this.emitter.on.bind(this.emitter);
    this.once = this.emitter.once.bind(this.emitter);
    this.off = this.emitter.off.bind(this.emitter);

    // 创建请求实例
    this.request = axios.create({
      baseURL: this.options.apiBaseUrl,
      headers: {
        Authorization: `Bearer ${this.token}`,
        "Content-Type": "application/json",
        Platform: "open_platform",
      },
    });

    try {
      this.size = this.getFileSizeSync(this.filePath);
      this.emitter.emit("progress", {
        event: "init",
        progress: 0,
        data: {
          loaded: 0,
          total: this.size,
        },
      });
    } catch (e) {
      this.emitter.emit("error", e as Error);
      this.status = "error";
      throw e;
    }
  }

  /**
   * 获取文件大小
   * @param filePath 文件路径
   * @returns 文件大小(字节)
   */
  private getFileSizeSync(filePath: string): number {
    const stats = fs.statSync(filePath);
    return stats.size;
  }

  /**
   * 开始上传文件
   * @returns 上传结果
   */
  async upload(
    target?: string
  ): Promise<{ fileId: string; filename: string } | undefined> {
    try {
      this.status = "running";
      this.emitter.emit("start");

      // 1. 创建上传任务
      const { sliceSize, preuploadID, fileID, reuse } =
        await this.createUploadTask(target);

      // 如果文件已存在（reuse为true），则直接返回结果，无需上传
      if (reuse) {
        const completedInfo = {
          fileId: fileID || preuploadID,
          filename: target || this.filename,
        };

        this.emitter.emit("progress", {
          event: "complete",
          progress: 1,
          data: {
            loaded: this.size,
            total: this.size,
          },
        });

        this.emitter.emit("completed", completedInfo);
        this.status = "completed";

        return completedInfo;
      }

      this.chunkSize = sliceSize;

      // 2. 计算分片数量
      const chunks = Math.ceil(this.size / this.chunkSize);

      // 3. 上传分片
      const status = await this.uploadChunks(preuploadID, chunks);
      if (!status) {
        if (this.status === "running") {
          throw new Error("上传失败");
        }
        return;
      }

      // 4. 完成上传
      const finishResult = await this.finishUpload(preuploadID);

      // 5. 如果是异步上传且未完成，需要轮询检查上传状态
      if (finishResult.asyncUpload && !finishResult.completed) {
        this.emitter.emit("progress", {
          event: "merging",
          progress: 1,
          data: {
            loaded: this.size,
            total: this.size,
            message: "检查上传状态...",
          },
        });

        // 轮询检查上传状态
        await this.pollUploadStatus(preuploadID);
      }

      // 6. 发送完成事件
      const completedInfo = {
        fileId: fileID || preuploadID,
        filename: target || this.filename,
      };

      this.emitter.emit("progress", {
        event: "complete",
        progress: 1,
        data: {
          loaded: this.size,
          total: this.size,
        },
      });

      this.emitter.emit("completed", completedInfo);
      this.status = "completed";

      return completedInfo;
    } catch (error) {
      if (this.status === "cancel") return;

      this.emitter.emit("error", error as Error);
      this.status = "error";
      throw error;
    }
  }

  /**
   * 创建上传任务
   * @returns 上传任务信息
   */
  private async createUploadTask(parentFileID?: string): Promise<{
    fileID: string;
    reuse: boolean;
    preuploadID: string;
    sliceSize: number;
  }> {
    this.emitter.emit("progress", {
      event: "preupload",
      progress: 0,
      data: {
        loaded: 0,
        total: this.size,
      },
    });

    try {
      // 计算文件MD5
      const etag = await md5File(this.filePath);

      const response = await this.request.post("/upload/v1/file/create", {
        parentFileID: parentFileID ?? this.parentFileID,
        filename: this.filename,
        size: this.size,
        etag,
        duplicate: this.options.duplicate,
      });

      if (response.data.code !== 0) {
        throw new Error(`创建上传任务失败: ${response.data.message}`);
      }

      return response.data.data;
    } catch (error) {
      this.emitter.emit("debug", { error, msg: "创建上传任务失败" });
      throw new Error(`创建上传任务失败: ${(error as Error).message}`);
    }
  }

  /**
   * 获取分片上传URL
   * @param uploadId 预上传ID
   * @param sliceNo 分片编号，从1开始
   * @returns 上传URL和已上传分片信息
   */
  private async getChunkUploadUrl(
    uploadId: string,
    sliceNo: number
  ): Promise<{
    presignedURL: string;
    isMultipart: boolean;
  }> {
    try {
      const response = await this.request.post(
        "/upload/v1/file/get_upload_url",
        {
          preuploadID: uploadId,
          sliceNo: sliceNo,
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`获取上传URL失败: ${response.data.message}`);
      }

      return response.data.data;
    } catch (error) {
      this.emitter.emit("debug", { error, msg: "获取上传URL失败" });
      throw new Error(`获取上传URL失败: ${(error as Error).message}`);
    }
  }

  /**
   * 上传分片
   * @param uploadId 上传ID
   * @param totalChunks 总分片数
   * @returns 是否上传成功
   */
  private uploadChunks(
    uploadId: string,
    totalChunks: number
  ): Promise<boolean> {
    return new Promise((resolve, reject) => {
      // 创建分片任务
      const chunkTasks: UploadChunkTask[] = [];

      for (let i = 0; i < totalChunks; i++) {
        const start = i * this.chunkSize;
        const end = Math.min(start + this.chunkSize, this.size);
        const chunkSize = end - start;

        const controller = new AbortController();
        const partNumber = i + 1;

        const task: UploadChunkTask = {
          filePath: this.filePath,
          start,
          chunkSize,
          size: this.size,
          token: this.token,
          uploadId,
          chunk: i,
          chunks: totalChunks,
          status: "pending",
          controller,
        };

        chunkTasks.push(task);
        this.chunkTasks[partNumber] = task;
      }

      // 将任务添加到队列
      for (const task of chunkTasks) {
        this.queue
          .add(() => this.uploadChunk(task))
          .catch(e => {
            this.emitter.emit("debug", { error: e, msg: "上传分片失败" });
          });
      }

      const parts: {
        partNumber: number;
      }[] = [];

      this.queue.on("error", error => {
        this.taskClear();
        reject(error);
      });

      this.queue.addListener(
        "completed",
        (result: { partNumber: number } | undefined) => {
          if (!result) return;

          const { partNumber } = result;
          this.chunkTasks[partNumber].status = "completed";
          parts.push({ partNumber });
        }
      );

      this.queue.on("idle", () => {
        if (parts.length === 0 && chunkTasks.length > 0) {
          resolve(false);
        } else if (parts.length === totalChunks) {
          resolve(true);
        } else {
          this.emitter.emit("debug", {
            text: "completed parts",
            parts,
            total: totalChunks,
            uploaded: parts.length,
          });
          resolve(false);
        }
      });
    });
  }

  /**
   * 上传单个分片
   * @param task 分片任务
   * @returns 上传结果
   */
  private async uploadChunk(
    task: UploadChunkTask,
    retryCount = 0
  ): Promise<{ partNumber: number } | undefined> {
    const { filePath, start, chunkSize, chunk } = task;
    const partNumber = chunk + 1;

    this.chunkTasks[partNumber].status = "running";

    try {
      // 读取分片数据
      const fileData = await this.readChunk(filePath, start, chunkSize);

      // 获取上传URL（每个分片可能需要单独获取）
      const { presignedURL } = await this.getChunkUploadUrl(
        task.uploadId,
        partNumber
      );

      // 上传分片
      await axios.put(presignedURL, fileData, {
        headers: {
          "Content-Type": "application/octet-stream",
        },
        onUploadProgress: (progressEvent: any) => {
          this.progress[partNumber] = progressEvent.loaded;
          const totalLoaded = Object.values(this.progress).reduce(
            (a, b) => a + b,
            0
          );

          this.emitter.emit("progress", {
            event: "uploading",
            progress: totalLoaded / this.size,
            data: {
              loaded: totalLoaded,
              total: this.size,
              chunk: partNumber,
              chunkProgress: progressEvent.loaded / chunkSize,
            },
          });
        },
        signal: task.controller.signal,
      });

      return { partNumber };
    } catch (error) {
      if (axios.isCancel(error)) {
        this.chunkTasks[partNumber].status = "abort";
        return;
      }

      if (retryCount < this.options.retryTimes) {
        // 等待重试
        await new Promise(resolve =>
          setTimeout(resolve, this.options.retryDelay)
        );
        return this.uploadChunk(task, retryCount + 1);
      }

      this.chunkTasks[partNumber].status = "error";
      throw error;
    }
  }

  /**
   * 读取文件分片
   * @param filePath 文件路径
   * @param start 起始位置
   * @param chunkSize 分片大小
   * @returns 文件分片缓冲区
   */
  private async readChunk(
    filePath: string,
    start: number,
    chunkSize: number
  ): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const endByte = start + chunkSize - 1;

      const readStream = fs.createReadStream(filePath, {
        start,
        end: endByte,
        highWaterMark: Math.min(chunkSize, 64 * 1024), // 64KB 块大小
      });

      const chunks: Buffer[] = [];
      let totalLength = 0;

      readStream.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        totalLength += chunk.length;
      });

      readStream.on("end", () => {
        try {
          const result = Buffer.concat(chunks, totalLength);
          // 立即清理chunks数组，释放内存
          chunks.length = 0;
          resolve(result);
        } catch (error) {
          chunks.length = 0;
          reject(error);
        }
      });

      readStream.on("error", err => {
        chunks.length = 0;
        reject(new Error(`读取文件失败: ${err.message}`));
      });
    });
  }

  /**
   * 完成上传
   * @param uploadId 上传ID
   * @returns 上传结果
   */
  private async finishUpload(uploadId: string): Promise<{
    asyncUpload: boolean;
    fileID: string;
    completed: boolean;
  }> {
    try {
      const response = await this.request.post(
        "/upload/v1/file/upload_complete",
        {
          preuploadID: uploadId,
        }
      );

      if (response.data.code !== 0) {
        throw new Error(`完成上传失败: ${response.data.message}`);
      }

      return response.data.data;
    } catch (error) {
      throw new Error(`完成上传失败: ${(error as Error).message}`);
    }
  }

  /**
   * 轮询检查上传状态
   * @param preuploadID 预上传ID
   */
  private async pollUploadStatus(preuploadID: string): Promise<void> {
    let pollCount = 0;
    const maxPollTimes = this.options.pollMaxTimes;
    const interval = this.options.pollInterval;

    while (pollCount < maxPollTimes) {
      pollCount++;

      try {
        const result = await this.checkMergeStatus(preuploadID);

        // 如果已完成，退出轮询
        if (result.completed) {
          this.emitter.emit("debug", {
            msg: "文件合并完成",
            pollCount,
          });
          return;
        }

        // 如果轮询次数达到上限，抛出错误
        if (pollCount >= maxPollTimes) {
          throw new Error("轮询检查上传状态超时");
        }

        this.emitter.emit("progress", {
          event: "merging",
          progress: 1,
          data: {
            loaded: this.size,
            total: this.size,
            pollCount,
            message: `检查上传状态: 第${pollCount}次检查`,
          },
        });

        // 等待指定时间后再次轮询
        await new Promise(resolve => setTimeout(resolve, interval));
      } catch (error) {
        throw new Error(`检查合并状态失败: ${(error as Error).message}`);
      }
    }
  }

  /**
   * 检查合并状态
   * @param preuploadID 预上传ID
   * @returns 检查结果
   */
  private async checkMergeStatus(preuploadID: string): Promise<{
    completed: boolean;
    fileID: string;
  }> {
    try {
      const response = await this.request.post("/upload/v1/file/check_merge", {
        preuploadID,
      });

      if (response.data.code !== 0) {
        throw new Error(`检查合并状态失败: ${response.data.message}`);
      }

      return response.data.data;
    } catch (error) {
      throw new Error(`检查合并状态失败: ${(error as Error).message}`);
    }
  }

  /**
   * 暂停上传
   */
  pause(): void {
    if (this.status !== "running") return;

    this.status = "paused";
    this.queue.pause();

    // 中止所有运行中的上传
    Object.values(this.chunkTasks)
      .filter(task => task.status === "running")
      .forEach(task => {
        this.progress[task.chunk + 1] = 0;
        task.controller.abort();
      });
  }

  /**
   * 继续上传
   */
  resume(): void {
    if (this.status !== "paused") return;

    this.status = "running";

    // 重新添加被中止的任务
    const abortedTasks = Object.values(this.chunkTasks).filter(
      task => task.status === "abort"
    );

    abortedTasks.forEach(task => {
      task.controller = new AbortController();
      task.status = "pending";
      this.queue
        .add(() => this.uploadChunk(task))
        .catch(e => {
          this.emitter.emit("debug", { error: e, msg: "上传分片失败" });
        });
    });

    this.queue.start();
  }

  /**
   * 取消上传
   */
  cancel(): void {
    this.status = "cancel";
    this.taskClear();
    this.emitter.emit("cancel");
  }

  /**
   * 清理所有任务
   */
  private taskClear(): void {
    this.queue.clear();
    Object.values(this.chunkTasks).forEach(task => {
      task.controller.abort();
    });
  }
}
