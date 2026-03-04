// ============================================
// Structured Logger
// ============================================
// Format: [LEVEL] [ISO-timestamp] [context] message
// Levels: debug < info < warn < error
// Set LOG_LEVEL env var to control minimum level (default: info)

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
    debug: 0,
    info:  1,
    warn:  2,
    error: 3,
};

const MIN_LEVEL: LogLevel = (process.env.LOG_LEVEL as LogLevel) ?? 'info';

function shouldLog(level: LogLevel): boolean {
    return LEVEL_ORDER[level] >= LEVEL_ORDER[MIN_LEVEL];
}

function format(level: LogLevel, context: string, message: string): string {
    const ts = new Date().toISOString();
    const lvl = level.toUpperCase().padEnd(5);
    return `[${lvl}] [${ts}] [${context}] ${message}`;
}

export class Logger {
    private context: string;

    constructor(context: string) {
        this.context = context;
    }

    debug(message: string): void {
        if (shouldLog('debug')) {
            console.debug(format('debug', this.context, message));
        }
    }

    info(message: string): void {
        if (shouldLog('info')) {
            console.log(format('info', this.context, message));
        }
    }

    warn(message: string): void {
        if (shouldLog('warn')) {
            console.warn(format('warn', this.context, message));
        }
    }

    error(message: string, err?: unknown): void {
        if (shouldLog('error')) {
            const detail = err instanceof Error ? ` — ${err.message}` : (err ? ` — ${String(err)}` : '');
            console.error(format('error', this.context, message + detail));
        }
    }
}
