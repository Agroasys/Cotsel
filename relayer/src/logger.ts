type LogMetadata = Record<string, unknown>;

function write(level: 'info' | 'warn' | 'error', message: string, metadata?: LogMetadata): void {
  const entry = JSON.stringify({
    level,
    timestamp: new Date().toISOString(),
    service: 'gasless-relayer',
    message,
    ...metadata,
  });
  if (level === 'error') console.error(entry);
  else if (level === 'warn') console.warn(entry);
  else console.log(entry);
}

export const logger = {
  info: (message: string, metadata?: LogMetadata) => write('info', message, metadata),
  warn: (message: string, metadata?: LogMetadata) => write('warn', message, metadata),
  error: (message: string, metadata?: LogMetadata) => write('error', message, metadata),
};
