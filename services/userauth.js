const { ipcRenderer } = require('electron');
const db = require('./db');
const config = require('../config1');

async function authenticateUser(userId, custId) {
    try {
        // Perform authentication logic with MySQL database
        const user = await db.query('SELECT User_ID,username,Customer_ID,Name,User_Type,user_design FROM usermaster WHERE user_id = ? AND customer_ID = ? and status = 1', [userId, custId]);

        if (user && user.length > 0) {
            // If user exists, return user data
            return user[0];
        } else {
            throw new Error('Invalid credentials');
        }
    } catch (error) {
        throw new Error('Authentication failed: ' + error.message);
    }
}

async function getUserFromDatabase(userId) {
        try {
            console.log("userid -> "+userId);
            const userData = await db.query(`select User_ID,username,User_Type from usermaster where User_id = ? and status = 1 and user_type = 0 and customer_id = 0`,[userId]);
            // Check if userData is not null
            if (userData && userData.length > 0) {
                // If userData is retrieved, parse it (if necessary) and return
                return userData[0];
            } else {
                // If userData is null, user does not exist in the database
                return null;
            }
        } catch (error) {
            // Handle errors appropriately (e.g., log or throw)
            console.error('Error fetching user data from Redis:', error);
            return error;
        }
    }
    

// Function to retrieve user from Redis database
// async function getUserFromDatabase(userId) {
//     try {
//         console.log("userid -> "+userId);
//         // Perform a GET operation to fetch user data based on userId
//         const userData = await db.redis.get("user:"+userId);
//         // console.log("userdata -> "+userData);
//         // Check if userData is not null
//         if (userData !== null) {
//             // If userData is retrieved, parse it (if necessary) and return
//             return JSON.parse(userData);
//         } else {
//             // If userData is null, user does not exist in the database
//             return null;
//         }
//     } catch (error) {
//         // Handle errors appropriately (e.g., log or throw)
//         console.error('Error fetching user data from Redis:', error);
//         throw error;
//     }
// }

async function setUserInDatabase(userId, userData) {
    try {
        // Convert userData to JSON string before storing in Redis
        const userDataString = JSON.stringify(userData);
        
        // Perform a SET operation to set user data with userId as key
        await db.redisClient.set("user:" + userId, userDataString); // Use db.redisClient here
        
        // Optionally, set an expiration time for the key if needed
        // await db.redisClient.expire(userId, 3600); // expire key after 1 hour (3600 seconds)
        
        console.log('User data successfully set in Redis for userId:', userId);
    } catch (error) {
        // Handle errors appropriately (e.g., log or throw)
        console.error('Error setting user data in Redis:', error);
        throw error;
    }
}

// Export the functions for testing if needed
module.exports = {
    authenticateUser,
    getUserFromDatabase,
    setUserInDatabase,
};
