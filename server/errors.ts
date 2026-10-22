export class ApiFailure extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what: string) => new ApiFailure(404, 'not_found', `找不到${what}`);
export const conflict = (message = '資料已被其他頁面或裝置修改，請重新載入後再編輯') => new ApiFailure(409, 'version_conflict', message);
export const forbidden = (message = '沒有權限執行此操作') => new ApiFailure(403, 'forbidden', message);
