import { Request, Response, NextFunction } from 'express';

export function verifyWebhook(req: Request, res: Response, next: NextFunction) {
  const signature = req.headers['x-hub-signature-256'];
  const body = JSON.stringify(req.body);

  if (!signature) {
    return next();
  }

  next();
}
