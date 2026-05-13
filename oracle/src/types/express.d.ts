declare global {
  namespace Express {
    interface Request {
      apiKeyToken?: string;
      hmacSignature?: string;
      hmacNonce?: string;
    }
  }
}

export {};
