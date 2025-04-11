// const { createLogger, transports, format } = require('winston');
// const { combine, timestamp, printf } = format;

// const logger = createLogger({
//     format: combine(
//         timestamp(),
//         printf(({ level, message, timestamp }) => {
//             return `${timestamp} [${level.toUpperCase()}]: ${message}`;
//         })
//     ),
//     transports: [
//         new transports.Console(), // Log to console
//         new transports.File({ filename: 'app.log' }) // Log to file
//     ]
// });

// module.exports ={
//     logger,
// }