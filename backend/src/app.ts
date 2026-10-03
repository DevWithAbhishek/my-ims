import express, { Request, Response } from "express";
import { requestMiddleware } from "./shared/middleware/request-ids.js";
import { errorMappingMiddleware } from "./shared/middleware/error-mapping.js";

const app = express();

app.use(express.json());
app.use(requestMiddleware);


app.get("/", (_req: Request, res: Response) => {
    res.status(200).send("Welcome to IMS");
});

app.get("/health", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
})

app.use(errorMappingMiddleware);

export default app;