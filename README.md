# 123 网盘上传器

一个基于 TypeScript 实现的 123 网盘文件上传工具，支持大文件分片上传、断点续传、进度监控等功能。

## 特性

- ✨ 大文件分片上传
- 📊 详细的上传进度监控
- 🔄 断点续传支持
- ⏸️ 暂停/恢复上传功能

## 安装

```bash
# 使用npm
npm install pan123-uploader

# 使用pnpm
pnpm add pan123-uploader

# 使用yarn
yarn add pan123-uploader
```

## 快速开始

### 获取 123 网盘访问令牌

请参考[123 网盘开放平台文档](https://www.123pan.com/developer)了解如何获取令牌。

### 获取 access_token

```typescript
import { getAccessToken } from "pan123-uploader";

const clientId = "xxxx";
const clientSecret = "xxx";
const res = await getAccessToken(clientId, clientSecret);
// 过期时间约为90天
const accessToken = res.data.accessToken;
```

### 创建文件夹

```typescript
import { getAccessToken, Client } from "pan123-uploader";
const res = await getAccessToken();
const accessToken = res.data.accessToken;

const client = new Client(accessToken);
// 创建文件夹，默认在根文件夹
client.mkdir("录播");
// 递归创建文件夹
client.mkdirRecursive("/录播/测试");
```

### 上传

### 基础用法

```typescript
import { Uploader } from "pan123-uploader";

// 创建上传实例
const uploader = new Uploader(
  "/path/to/your/file.mp4", // 文件路径
  "access_token", // 123网盘访问令牌
  "0" // 父目录ID（默认为根目录）
);

// 监听上传进度
uploader.on("progress", data => {
  console.log(`上传进度: ${(data.progress * 100).toFixed(2)}%`);
});

// 监听上传完成
uploader.on("completed", data => {
  console.log(`上传完成! 文件ID: ${data.fileId}, 文件名: ${data.filename}`);
});

// 监听错误
uploader.on("error", err => {
  console.error("上传出错:", err);
});

// 开始上传
uploader
  .upload()
  .then(result => {
    if (result) {
      console.log("上传成功:", result);
    }
  })
  .catch(err => {
    console.error("上传失败:", err);
  });
```

### 高级用法

```typescript
import { Uploader } from "pan123-uploader";

// 创建带有自定义选项的上传实例
const uploader = new Uploader(
  "/path/to/large/file.zip",
  "your_123pan_token",
  "folder_id",
  {
    concurrency: 5, // 同时上传5个分片
    retryTimes: 5, // 失败重试5次
    retryDelay: 5000, // 重试间隔5秒
    pollInterval: 3000, // 合并状态检查间隔3秒
    pollMaxTimes: 60, // 最多轮询60次（约3分钟）
  }
);

// 添加所有事件监听器
uploader.on("start", () => console.log("开始上传"));
uploader.on("progress", data => {
  switch (data.event) {
    case "init":
      console.log("初始化上传");
      break;
    case "preupload":
      console.log("预上传准备中");
      break;
    case "uploading":
      console.log(`上传中: ${(data.progress * 100).toFixed(2)}%`);
      break;
    case "merging":
      console.log("文件合并中...");
      break;
    case "complete":
      console.log("上传完成");
      break;
  }
});
uploader.on("debug", data => console.log("调试信息:", data));

// 开始上传
const result = await uploader.upload();

// 暂停上传示例
setTimeout(() => {
  console.log("暂停上传");
  uploader.pause();

  // 3秒后恢复上传
  setTimeout(() => {
    console.log("恢复上传");
    uploader.resume();
  }, 3000);
}, 5000);
```

## API 文档

### Uploader 类

主要上传类，用于处理文件上传过程。

#### 构造函数

```typescript
constructor(
  filePath: string,           // 本地文件路径
  token: string,              // 123网盘API访问令牌
  parentFileID: string = "0", // 父目录ID，默认为根目录
  options?: {                 // 可选配置
    concurrency?: number;     // 并发上传分片数，默认3
    retryTimes?: number;      // 失败重试次数，默认3
    retryDelay?: number;      // 重试间隔(ms)，默认3000
    limitRate?: number;       // 限速(B/s)，默认0(不限速)
    duplicate?: number;       // 文件重复处理策略，默认1
    pollInterval?: number;    // 合并状态检查间隔(ms)，默认2000
    pollMaxTimes?: number;    // 最大轮询次数，默认30
  }
)
```

#### 方法

| 方法       | 说明         | 返回值                                                   |
| ---------- | ------------ | -------------------------------------------------------- |
| `upload()` | 开始上传文件 | Promise<{fileId: string, filename: string} \| undefined> |
| `pause()`  | 暂停上传     | void                                                     |
| `resume()` | 继续上传     | void                                                     |
| `cancel()` | 取消上传     | void                                                     |

#### 事件

Uploader 类通过 TypedEmitter 实现了事件机制，可以监听以下事件：

| 事件名      | 回调参数                  | 说明               |
| ----------- | ------------------------- | ------------------ |
| `start`     | 无                        | 上传开始时触发     |
| `progress`  | { event, progress, data } | 上传进度更新时触发 |
| `completed` | { fileId, filename }      | 上传完成时触发     |
| `error`     | Error                     | 上传出错时触发     |
| `cancel`    | 无                        | 上传取消时触发     |
| `debug`     | any                       | 调试信息           |

progress 事件的 event 字段可能的值：

- `init`: 初始化
- `preupload`: 预上传阶段
- `uploading`: 上传分片阶段
- `merging`: 服务器合并分片阶段
- `complete`: 上传完成

## 原理说明

123 网盘上传采用分片上传策略，主要流程如下：

1. 创建上传任务，获取预上传 ID
2. 将文件分割成多个小块（默认 4MB 一块）
3. 并发上传这些分块到存储服务器
4. 通知服务器所有分块已上传完成
5. 轮询检查服务器端分块合并状态
6. 完成上传

## 许可证

MIT
