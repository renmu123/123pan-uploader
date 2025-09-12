interface RequestConfig {
  headers?: Record<string, string>;
  timeout?: number;
  baseURL?: string;
}

interface ResponseType<T = any> {
  data: T;
  status: number;
  statusText: string;
  headers: Headers;
  config: RequestConfig;
}

interface RequestInterceptor {
  (config: RequestConfig): RequestConfig | Promise<RequestConfig>;
}

interface ResponseInterceptor<T = any> {
  (response: ResponseType<T>): ResponseType<T> | Promise<ResponseType<T>>;
}

interface ErrorInterceptor {
  (error: Error): Promise<never>;
}

export class HttpClient {
  private baseURL: string = "";
  private defaultHeaders: Record<string, string> = {};
  private timeout: number = 10000;
  private requestInterceptors: RequestInterceptor[] = [];
  private responseInterceptors: ResponseInterceptor[] = [];
  private errorInterceptors: ErrorInterceptor[] = [];

  constructor(config: RequestConfig = {}) {
    this.baseURL = config.baseURL || "";
    this.defaultHeaders = config.headers || {};
    this.timeout = config.timeout || 10000;
  }

  // 创建新的实例
  static create(config: RequestConfig = {}): HttpClient {
    return new HttpClient(config);
  }

  // 拦截器
  get interceptors() {
    return {
      request: {
        use: (onFulfilled: RequestInterceptor) => {
          this.requestInterceptors.push(onFulfilled);
        },
      },
      response: {
        use: (
          onFulfilled: ResponseInterceptor,
          onRejected?: ErrorInterceptor
        ) => {
          this.responseInterceptors.push(onFulfilled);
          if (onRejected) {
            this.errorInterceptors.push(onRejected);
          }
        },
      },
    };
  }

  private async executeRequest<T = any>(
    url: string,
    options: RequestInit & { params?: Record<string, any> } = {}
  ): Promise<ResponseType<T>> {
    // 处理 URL
    const fullUrl = this.buildUrl(url, options.params);

    // 构建配置
    let config: RequestConfig = {
      baseURL: this.baseURL,
      headers: {
        ...this.defaultHeaders,
        ...((options.headers as Record<string, string>) || {}),
      },
    };

    // 执行请求拦截器
    for (const interceptor of this.requestInterceptors) {
      config = await interceptor(config);
    }

    // 构建 fetch 选项
    const fetchOptions: RequestInit = {
      ...options,
      headers: config.headers,
      signal: AbortSignal.timeout(this.timeout),
    };

    try {
      const response = await fetch(fullUrl, fetchOptions);

      let data: T;
      const contentType = response.headers.get("content-type");

      if (contentType && contentType.includes("application/json")) {
        data = (await response.json()) as T;
      } else {
        data = (await response.text()) as T;
      }

      const result: ResponseType<T> = {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        config,
      };

      // 执行响应拦截器
      let finalResult = result;
      for (const interceptor of this.responseInterceptors) {
        finalResult = await interceptor(finalResult);
      }

      return finalResult;
    } catch (error) {
      // 执行错误拦截器
      for (const interceptor of this.errorInterceptors) {
        await interceptor(error as Error);
      }
      throw error;
    }
  }

  private buildUrl(url: string, params?: Record<string, any>): string {
    let fullUrl = url.startsWith("http") ? url : `${this.baseURL}${url}`;

    if (params) {
      const searchParams = new URLSearchParams();
      Object.entries(params).forEach(([key, value]) => {
        if (value !== undefined && value !== null) {
          searchParams.append(key, String(value));
        }
      });
      const queryString = searchParams.toString();
      if (queryString) {
        fullUrl += (fullUrl.includes("?") ? "&" : "?") + queryString;
      }
    }

    return fullUrl;
  }

  // GET 请求
  async get<T = any>(
    url: string,
    config: {
      params?: Record<string, any>;
      headers?: Record<string, string>;
    } = {}
  ): Promise<ResponseType<T>> {
    return this.executeRequest<T>(url, {
      method: "GET",
      params: config.params,
      headers: config.headers,
    });
  }

  // POST 请求
  async post<T = any>(
    url: string,
    data?: any,
    config: { headers?: Record<string, string> } = {}
  ): Promise<ResponseType<T>> {
    const headers = { ...config.headers };
    let body: string | undefined;

    if (data) {
      if (typeof data === "object") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(data);
      } else {
        body = data;
      }
    }

    return this.executeRequest<T>(url, {
      method: "POST",
      body,
      headers,
    });
  }

  // PUT 请求
  async put<T = any>(
    url: string,
    data?: any,
    config: { headers?: Record<string, string> } = {}
  ): Promise<ResponseType<T>> {
    const headers = { ...config.headers };
    let body: string | undefined;

    if (data) {
      if (typeof data === "object") {
        headers["Content-Type"] = "application/json";
        body = JSON.stringify(data);
      } else {
        body = data;
      }
    }

    return this.executeRequest<T>(url, {
      method: "PUT",
      body,
      headers,
    });
  }

  // DELETE 请求
  async delete<T = any>(
    url: string,
    config: { headers?: Record<string, string> } = {}
  ): Promise<ResponseType<T>> {
    return this.executeRequest<T>(url, {
      method: "DELETE",
      headers: config.headers,
    });
  }
}

// 导出默认实例
export const http = new HttpClient();

// 便利函数
export async function get<T = any>(
  url: string,
  config?: { params?: Record<string, any>; headers?: Record<string, string> }
): Promise<ResponseType<T>> {
  return http.get<T>(url, config);
}

export async function post<T = any>(
  url: string,
  data?: any,
  config?: { headers?: Record<string, string> }
): Promise<ResponseType<T>> {
  return http.post<T>(url, data, config);
}
