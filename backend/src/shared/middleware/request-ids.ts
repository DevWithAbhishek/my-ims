import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

export const requestIdHeader = "x-request-id";

export function requestMiddleware(req: Request, res: Response, next: NextFunction) {
    const incoming = req.header(requestIdHeader);
    const requestId = incoming && incoming.trim().length > 0 ? incoming : crypto.randomUUID();

    res.locals.requestId = requestId;
    res.setHeader("X-Request-Id", requestId);
    next();
}