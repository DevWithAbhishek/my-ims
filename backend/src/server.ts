import app from "./app.js";
import { logger } from "./shared/observability/logger.js";

const PORT = 3000;

const server = app.listen(PORT, () => {
    logger.info({ port: 3000 }, "Server Listening");
});

server.on("error", (error) => {
    logger.fatal({ error }, "Server failed to start");
    process.exit(1);
})