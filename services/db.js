const Redis = require('ioredis');
const mysql = require('mysql2/promise');
const config = require('../config');
const pool = mysql.createPool(config.db);
const pool1 = mysql.createPool(config.db1);
const preparedStatements = new Map();

// Create a Redis client instance
const redis = new Redis({
    host: '192.168.0.245', // Replace with your Redis host
    port: 6379, // Replace with your Redis port
});

async function query(sql, params) {
    const connection = await pool.getConnection();
    try {
        const [results, ] = await connection.execute(sql, params);
        return results;
    } catch (error) {
        throw error;
    } finally {
        connection.release(); // Release the connection back to the pool
    }
}

async function spcall(sql, params) {
    const connection = await pool.getConnection();
    try {
        const results = await connection.query(sql, params);
        return results;
    } catch (error) {
        throw error;
    } finally {
        connection.release(); // Release the connection back to the pool
    }
}
async function spcall1(sql, params) {
    const connection = await pool1.getConnection();
    try {
        const results = await connection.query(sql, params);
        return results;
    } catch (error) {
        throw error;
    } finally {
        connection.release(); // Release the connection back to the pool
    }
}

async function queryWithPreparedStatement(sql, params) {
    const connection = await pool.getConnection();
    try {
        let statement;
        if (preparedStatements.has(sql)) {
            statement = preparedStatements.get(sql);
        } else {
            statement = await connection.prepare(sql);
            preparedStatements.set(sql, statement);
        }
        const [results, ] = await statement.execute(params);
        return results;
    } catch (error) {
        throw error;
    } finally {
        connection.release();
    }
}




// Export the function
module.exports = {
    redis,
    query,
    spcall,
    spcall1,
    pool,
    queryWithPreparedStatement

};
