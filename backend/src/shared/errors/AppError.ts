export type AppErrorOptions = {
    statusCode: number,
    code: string,
    message: string,
    expose?: boolean
};

export class AppError extends Error {
    readonly statusCode: number;
    readonly code: string;
    readonly expose: boolean;

    constructor({ statusCode, code, message, expose = true }: AppErrorOptions) {
        super(message);
        this.name = new.target.name;
        this.statusCode = statusCode;
        this.code = code;
        this.expose = expose;
    }
}

export class BadRequestError extends AppError {
    constructor(message: string, code = "BAD_REQUEST") {
        super({ statusCode: 400, code, message });
    }
}

export class UnauthorizedError extends AppError {
    constructor(message = "Unauthorized", code = "UNAUTHORIZED") {
        super({ statusCode: 401, code, message });
    }
}

export class ForbiddenError extends AppError {
    constructor(message = "Forbidden", code = "FORBIDDEN") {
        super({ statusCode: 403, code, message });
    }
}

export class NotFoundError extends AppError {
    constructor(message = "Not found", code = "NOT_FOUND") {
        super({ statusCode: 404, code, message });
    }
}

export class ConflictError extends AppError {
    constructor(message: string, code = "CONFLICT") {
        super({ statusCode: 409, code, message });
    }
}

export class ServiceUnavailableError extends AppError {
    constructor(message = "Service unavailable", code = "SERVICE_UNAVAILABLE") {
        super({ statusCode: 503, code, message });
    }
}