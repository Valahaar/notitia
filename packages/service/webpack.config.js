// Bundles user code into a single dist/main.js. node_modules are intentionally
// kept external (default NestJS behaviour) so packages that depend on runtime
// file resolution — gRPC proto loaders in @google-cloud/tasks, swagger-ui
// static assets, pino transports — keep working untouched. The win here is
// avoiding hundreds of fs.stat / fs.read calls on every cold start to walk our
// own controllers / DTOs / services.
module.exports = function (options, webpack) {
    return {
        ...options,
        entry: ['./src/main.ts'],
        output: {
            ...options.output,
            filename: 'main.js',
        },
        plugins: [
            ...(options.plugins ?? []),
            // Suppress optional Nest peer deps that we don't actually use, so
            // webpack doesn't warn / fail when it can't resolve them.
            new webpack.IgnorePlugin({
                checkResource(resource) {
                    const lazyImports = [
                        '@nestjs/microservices',
                        '@nestjs/microservices/microservices-module',
                        '@nestjs/websockets/socket-module',
                    ];
                    if (!lazyImports.includes(resource)) return false;
                    try {
                        require.resolve(resource, { paths: [process.cwd()] });
                    } catch {
                        return true;
                    }
                    return false;
                },
            }),
        ],
    };
};
