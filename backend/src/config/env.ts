import dotenv from "dotenv";
import type { StringValue } from "ms";

dotenv.config();

interface Config {
    port: number,
    nodeEnv: string,
    databaseUrl: string,
    directUrl: string,
    jwtSecret: string,
    accessTokenExpiry: StringValue,
    refreshTokenExpiry: StringValue
};

const config: Config = {
    port: Number(process.env.PORT) || 3000,
    nodeEnv: process.env.NODE_ENV || 'development',
    databaseUrl: process.env.DATABASE_URL!,
    directUrl: process.env.DIRECT_URL!,
    jwtSecret: process.env.JWT_SECRET!,
    accessTokenExpiry: (process.env.ACCESS_TOKEN_EXPIRY || "15m") as StringValue,
    refreshTokenExpiry: (process.env.REFRESH_TOKEN_EXPIRY || "7d") as StringValue
};

export default config;
