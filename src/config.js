module.exports = {
  corsOrigin: [/127\.0\.0\.1/, /\.?etcnodes\.org$/],

  // List of server endpoints to poll for live stats
  liveStatsServers: [
    'https://etc.rivet.link',
    'https://rpc.mainnet.etccooperative.org'
  ],

  // List of bootnodes to fetch peers from
  peerServers: [
    [
      'https://ams.peers.etcnodes.org:8540',
      {
        auth: {
          username: process.env.NODE_AUTH_USERNAME,
          password: process.env.NODE_AUTH_PASSWORD,
        },
      },
    ],
    [
      'https://sfo.peers.etcnodes.org:8540',
      {
        auth: {
          username: process.env.NODE_AUTH_USERNAME,
          password: process.env.NODE_AUTH_PASSWORD,
        },
      },
    ],
    [
      'https://nyc.peers.etcnodes.org:8540',
      {
        auth: {
          username: process.env.NODE_AUTH_USERNAME,
          password: process.env.NODE_AUTH_PASSWORD,
        },
      },
    ],
    ['https://peers.etccore.in/v5/nodes.json', {}],
  ],

  peersAutoUpdateIntervalInMillies: 5 * 60 * 1000, // 5 minutes

  // For how long to keep a peer in the list if it's not responding
  stalePeerDeleteThresholdInSeconds: 60 * 60 * 24, // 1 day

  // Time to cache the info for an IP address
  ipInfoApiCacheExpiryInSeconds: 10 * 60 * 60 * 24, // 10 days
};
