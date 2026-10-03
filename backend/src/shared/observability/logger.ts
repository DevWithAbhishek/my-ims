import pino from "pino";
// import {env} from "../config/env.js"

export type LogContext = {
    requestId?: string;
    actorId?: string;
    actorRole?: string;
    teamId?: string;
    incidentId?: string;
};

export const logger = pino({
    level: "info",
    base: null,
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
        level(label) {
            return { level: label };
        },
    },
});

export function childLogger(context: LogContext) {
    return logger.child(context);
}