const config ={
  user_channel : 0,
  db: {
      /* don't expose password or any sensitive info, done only for demo */
      host: "192.168.0.158",
      user: "ssipl_serveradmin",
      password: "Sporada@2014",
      multipleStatements: true,
      database: "ssipl_clouddb1",
    },
    db1: {
      /* don't expose password or any sensitive info, done only for demo */
      host: "192.168.0.159",
      user: "ssipl_serveradmin",
      password: "Sporada@2014",
      multipleStatements: true,
      database: "ssipl_clouddb1",
    },
  notificationhost : "localhost",
  notificationport : 55566,
  endpointport : 55554,
  tcpport : 55555
};



module.exports = config;