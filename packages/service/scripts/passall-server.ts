import express from 'express';
import { Request, Response } from 'express';

(() => {

    const app = express();
    const port = process.env.PORT || 3000;

    // Middleware to parse JSON bodies
    app.use(express.json());

    // Middleware to parse URL-encoded bodies
    app.use(express.urlencoded({ extended: true }));

    // Catch-all route handler
    app.all(/(.*)/, (req: Request, res: Response) => {
        console.log('\n=== New Request ===');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Method:', req.method);
        console.log('URL:', req.url);
        console.log('Headers:', JSON.stringify(req.headers, null, 2));
        console.log('Query Parameters:', JSON.stringify(req.query, null, 2));
        console.log('Body:', JSON.stringify(req.body, null, 2));
        console.log('Params:', JSON.stringify(req.params, null, 2));
        console.log('==================\n');

        // Always return 200 OK
        res.status(200).json({
            message: 'Request received and logged',
            timestamp: new Date().toISOString()
        });
    });

    app.listen(port, () => {
        console.log(`Passall server listening on port ${port}`);
    });

})();