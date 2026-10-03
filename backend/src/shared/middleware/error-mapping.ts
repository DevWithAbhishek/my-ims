import type { ErrorRequestHandler } from 'express';
import { AppError } from '../errors/AppError.js';
import { logger } from '../observability/logger.js';

export const errorMappingMiddleware: ErrorRequestHandler = (error, _rq, res, _next) => {
    const requestId = res.locals.requestId as string | undefined;

    if (error instanceof AppError) {
        logger.warn(
            {
                requestId,
                errorCode: error.code,
                statusCode: error.statusCode,
            },
            error.message,
        );

        res.status(error.statusCode).json({
            error: {
                code: error.code,
                message: error.expose ? error.message : 'Internal server error',
            },
        });

        return;
    }

    logger.warn({
        requestId,
        error
    }, "Unhandled Error");

    res.status(500).json({
        error: {
            code: "INTERNAL_SERVER_ERROR",
            message: "Internal Server Error",
        }
    });
};
