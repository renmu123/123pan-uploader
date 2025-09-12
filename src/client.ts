import { HttpClient, post } from "./http.js";

export async function getAccessToken(
  clientID: string,
  clientSecret: string
): Promise<{
  code: number;
  message: string;
  data: {
    accessToken: string;
    expiredAt: string;
  } | null;
  "x-traceID": string;
}> {
  const response = await post(
    "https://open-api.123pan.com/api/v1/access_token",
    {
      clientID,
      clientSecret,
    },
    {
      headers: {
        Platform: "open_platform",
        "Content-Type": "application/json",
      },
    }
  );
  return response.data;
}

export class Client {
  private accessToken: string;
  private request: HttpClient;
  constructor(accessToken: string) {
    this.accessToken = accessToken;
    this.request = HttpClient.create({
      baseURL: "https://open-api.123pan.com",
      headers: {
        Platform: "open_platform",
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.accessToken}`,
      },
    });

    this.request.interceptors.response.use(
      response => {
        const config = response.config;

        if (response.data?.code !== 0) {
          const message = response?.data?.message || "no message";
          const error = new Error(
            `code:${response?.data?.code}, x-traceID:${response?.data?.["x-traceID"]}, message:${message}`
          );
          return Promise.reject(error);
        } else {
          return Promise.resolve(response.data);
        }
      },
      error => {
        return Promise.reject(error);
      }
    );
  }

  /**
   * 创建文件夹
   * @param name 文件夹名称
   * @param parentID 父文件夹ID, 默认0
   * @returns 文件夹ID
   */
  async mkdir(
    name: string,
    parentID: number = 0
  ): Promise<{
    dirID: number;
  }> {
    const response = await this.request.post("/upload/v1/file/mkdir", {
      name,
      parentID,
    });
    return response.data;
  }
  /**
   * 递归创建目录
   * @param path 目录路径, 例如: /a/b/c
   * @returns 目录ID
   */
  async mkdirRecursive(path: string) {
    const paths = path.split("/").filter(Boolean);
    let currentID = 0;
    for (const p of paths) {
      try {
        const response = await this.mkdir(p, currentID);
        currentID = response.dirID;
      } catch (error) {
        const message = error.message;
        if (message.includes("文件名要小于256个字符且不能包含以下任何字符")) {
          throw error;
        }
        if (message.includes("该目录下已经有同名文件夹")) {
          let lastFileId = 0;
          let folder = null;
          while (true) {
            const fileList = await this.getFileList({
              parentFileID: currentID,
              lastFileId,
            });
            folder = fileList.fileList.find(
              item =>
                item.filename === p && item.type === 1 && item.trashed === 0
            );
            if (folder) {
              break;
            }
            if (fileList.fileList.length < 100) {
              break;
            }
            lastFileId = fileList.lastFileId;
          }
          if (!folder) {
            throw new Error("递归创建文件夹失败");
          }

          currentID = folder.fileId;
          continue;
        }
      }
    }
    return currentID;
  }

  /**
   * 获取文件列表
   */
  async getFileList(iOptions: {
    parentFileID?: number;
    lastFileId?: number;
    limit?: number;
    searchData?: string;
    searchMode?: 0 | 1;
  }): Promise<{
    lastFileId: number;
    fileList: Array<{
      fileId: number;
      filename: string;
      parentFileId: number;
      // 0-文件  1-文件夹
      type: 0 | 1;
      etag: string;
      size: number;
      // 文件分类：0-未知 1-音频 2-视频 3-图片
      category: 0 | 1 | 2 | 3;
      status: number;
      punishFlag: number;
      s3KeyFlag: string;
      storageNode: string;
      // [0：否，1：是]
      trashed: 0 | 1;
      createAt: string;
      updateAt: string;
    }>;
  }> {
    const options = Object.assign(
      {
        parentFileID: 0,
        lastFileId: 0,
        limit: 100,
        searchData: "",
        searchMode: 0,
      },
      iOptions
    );
    const response = await this.request.get("/api/v2/file/list", {
      params: options,
    });
    return response.data;
  }

  /**
   * 获取用户信息
   */
  async getUserInfo(): Promise<{
    /** 用户账号ID */
    uid: number;
    /** 用户昵称 */
    nickname: string;
    /** 用户头像URL */
    headImage: string;
    /** 用户手机号码 */
    passport: string;
    /** 用户邮箱 */
    mail: string;
    /** 已用存储空间（字节） */
    spaceUsed: number;
    /** 永久存储空间（字节） */
    spacePermanent: number;
    /** 临时存储空间（字节） */
    spaceTemp: number;
    /** 临时空间到期日 */
    spaceTempExpr: string;
    /** 是否为VIP会员 */
    vip: boolean;
    /** 剩余直链流量 */
    directTraffic: number;
    /** 直链链接是否隐藏UID */
    isHideUID: boolean;
    /** HTTPS数量 */
    httpsCount: number;
    /** VIP信息（非VIP用户为null） */
    vipInfo: {
      /** VIP等级（1-VIP, 2-SVIP, 3-长期VIP） */
      vipLevel: number;
      /** VIP级别名称 */
      vipLabel: string;
      /** VIP开始时间 */
      startTime: string;
      /** VIP结束时间 */
      endTime: string;
    } | null;
    /** 开发者权益信息 */
    developerInfo: {
      /** 开发者权益开始时间 */
      startTime: string;
      /** 开发者权益结束时间 */
      endTime: string;
    } | null;
  }> {
    const response = await this.request.get("/api/v1/user/info");
    return response.data;
  }
}
