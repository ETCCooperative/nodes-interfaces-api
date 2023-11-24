module.exports = {
  corsOrigin: [/127\.0\.0\.1/, /\.?etcnodes\.org$/],

  // List of server endpoints to poll for live stats
  liveStatsServers: [
    'https://etc.rivet.link',
    'https://rpc.mainnet.etccooperative.org'
  ],

  // List of bootnodes to fetch peers from
  peerServers: [
    'https://ams.peers.etcnodes.org:8540',
    // 'https://sfo.peers.etcnodes.org:8540',
    // 'https://nyc.peers.etcnodes.org:8540',
    // 'https://peers.etccore.in/v5/nodes.json',
  ],

  // How often to ask a bootnode to check if a peer is still alive
  stalePeerRefreshThreshold: 60 * 60 * 12, // 12 hours

  // For how long to keep a peer in the list if it's not responding
  stalePeerDeleteThreshold: 60 * 60 * 24 * 2, // 2 days
};
