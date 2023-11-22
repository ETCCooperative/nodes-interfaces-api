const axios = require('axios');
const express = require('express');
const redisClient = require('../utils/redisClient');
const { IPinfoWrapper } = require('node-ipinfo');
const config = require('../config');

const router = express.Router();

const peersNodeKey = 'peers';
const peersDebugNodeKey = 'peersDebug';

const IPINFO_API_TOKEN = process.env.IPINFO_API_TOKEN;

if (!IPINFO_API_TOKEN) {
  throw new Error('Missing IPINFO_API_TOKEN');
}

const ipinfoWrapper = new IPinfoWrapper(IPINFO_API_TOKEN);

// Example node response:
//
// [
//   {
//     "enode": "enode://9e3cc690a3d3ccfd5c9229fea53107f46631a4456e55c5bd849e72e50e10b4fbffa81063e8174b57285b199ac71abb9063ef391199abfc2c86d64c6dfa001402@174.92.149.225:51650",
//     "id": "197abd552b6817a499f85e46b70c5eed9cdf7aeed977a383f18965c42e6062ec",
//     "name": "CoreGeth/ETCMCgethNode/v1.12.10-stable-4d217763/windows-amd64/go1.18.5",
//     "caps": [
//         "eth/66",
//         "eth/67",
//         "snap/1"
//     ],
//     "network": {
//         "localAddress": "159.203.56.33:30369",
//         "remoteAddress": "174.92.149.225:51650",
//         "inbound": true,
//         "trusted": false,
//         "static": false
//     },
//     "protocols": {
//         "eth": {
//             "difficulty": 7.301447234719e+21,
//             "forkId": {
//                 "hash": "0x7fd1bb25",
//                 "next": 0
//             },
//             "head": "0x4ad28ce4344bbb39c64ca36ff21c8291fb8a78044730a92052f99e5718fd2ad7",
//             "version": 67
//         },
//         "snap": {
//             "version": 1
//         }
//     },
//     "ip_info": {
//         "ip": "174.92.149.225",
//         "hostname": "bras-base-sconpq1802w-grc-04-174-92-149-225.dsl.bell.ca",
//         "city": "Saint-Constant",
//         "region": "Quebec",
//         "country": "CA",
//         "country_name": "Canada",
//         "loc": "45.3668,-73.5659",
//         "org": "AS577 Bell Canada",
//         "postal": "J5A",
//         "timezone": "America/Toronto"
//     },
//     "contact": {
//         "first": {
//             "unix": 1700640068,
//             "rfc3339": "2023-11-22T08:01:08Z"
//         },
//         "last": {
//             "unix": 1700643661,
//             "rfc3339": "2023-11-22T09:01:01Z"
//         },
//         "refresh": {
//             "unix": 1700640068,
//             "rfc3339": "2023-11-22T08:01:08Z"
//         }
//     }
//   }
// ]

const augmentWithIPInfo = async (ip) => {
  const redisKey = `ipInfo.${ip}`;
  let ipInfo = await redisClient.get(redisKey);
  if (ipInfo) {
    ipInfo = JSON.parse(ipInfo);
  } else {
    try {
      ipInfo = await ipinfoWrapper.lookupIp(ip);
      await redisClient.set(redisKey, JSON.stringify(ipInfo), {
        EX: 2 * 60 * 60 * 24, // 2 days
      });
    } catch (err) {
      console.error(`Error retrieving IP info:`, err);
      return {};
    }
  }
  return ipInfo;
};

const setContactToNowFor = (key, peer = {}) => {
  if (!key || !peer || !peer.contact || !peer.contact[key]) {
    return;
  }

  const now = new Date();
  const contactNow = {
    unix: Math.floor(now / 1000),
    rfc3339: now.toISOString(),
  };

  peer.contact[key] = contactNow;

  return peer;
};
const getInitialContactInfoForNow = () => {
  const now = new Date();
  const contactNow = {
    unix: Math.floor(now / 1000),
    rfc3339: now.toISOString(),
  };

  return {
    first: contactNow,
    last: contactNow,
    refresh: contactNow,
  };
};

// Checks if peer is stale and should be refreshed at the node
function shouldRefreshPeer(peer) {
  const { refresh: { unix: lastRefreshUnix = 0 } = {} } = peer.contact;
  const now = Math.floor(new Date() / 1000);
  const diff = now - lastRefreshUnix;

  return diff > config.stalePeerRefreshThreshold;
}

// Checks if peer is stale and should be deleted from the cache
function shouldDeletePeer(peer) {
  const { last: { unix: lastUnix = 0 } = {} } = peer.contact;
  const now = Math.floor(new Date() / 1000);
  const diff = now - lastUnix;

  return diff > config.stalePeerDeleteThreshold;
}

const requestNodeToRefreshPeer = async (enode, server) => {
  const resRemovePeer = await axios.post(server, {
    method: 'admin_removePeer',
    jsonrpc: '2.0',
    params: [enode],
    id: Date.now(),
  });

  if (resRemovePeer.status !== 200 || resRemovePeer.data.error) {
    console.error(
      `Error removing peer ${enode} on server ${server}:`,
      resRemovePeer.data
    );
    return;
  }

  const resAddPeer = await axios.post(server, {
    method: 'admin_addPeer',
    jsonrpc: '2.0',
    params: [enode],
    id: Date.now(),
  });

  if (resAddPeer.status !== 200 || resAddPeer.data.error) {
    console.error(
      `Error removing peer ${enode} on server ${server}:`,
      resAddPeer.data
    );
    return;
  }
};

const updatePeers = async () => {
  let peers = {
    // {
    //   id : '123',
    //   ...peerInfo,
    //   ip_info: {},
    //   contact: {},
    // }
  };

  // Load anterior peers
  let cachedPeers = await redisClient.get(peersNodeKey);
  if (cachedPeers) {
    peers = JSON.parse(cachedPeers);
  }

  let peerDebugInfo = await redisClient.get(peersDebugNodeKey);
  if (peerDebugInfo) {
    peerDebugInfo = JSON.parse(peerDebugInfo);
  } else {
    peerDebugInfo = {
      // [key]: {
      //   keep where we found this peer,
      //   we don't have to know all of them, just the last one is fine
      //   bootnode: 'https://...',
      // }
    };
  }

  const requestData = {
    method: 'admin_peers',
    jsonrpc: '2.0',
    params: [],
    id: Date.now(),
  };

  const initialContactInfo = getInitialContactInfoForNow();

  // 1. Collect all the peers from nodes
  try {
    const statsPromises = config.peerServers.map((url) =>
      axios.post(url, requestData)
    );
    const responses = await Promise.all(statsPromises);

    responses.forEach(async (response, idx) => {
      const { data: { result = [] } = {} } = response;

      // 2. Merge peers
      peers = result.reduce((acc, peerInfo) => {
        const peerId = peerInfo.id;
        let peer = {
          contact: initialContactInfo, // this will be overwritten if set in cache
          ...peers[peerId],
          ...peerInfo,
        };

        peer = setContactToNowFor('last', peer);

        acc[peerId] = peer;

        // Keep some debug info
        peerDebugInfo[peerId] = {
          ...(peerDebugInfo[peerId] || {}),
          bootnode: config.peerServers[idx],
        };
        return acc;
      }, peers);
    });
  } catch (error) {
    console.error('Error polling servers:', error);
    throw new Response('No data found', { status: 404 });
  }

  // 3. Augment with IP and contact info
  for await (const peerId of Object.keys(peers)) {
    // 4. Augment with IP info
    if (
      typeof peers[peerId].ip_info !== 'object' ||
      Object.keys(peers[peerId].ip_info).length === 0
    ) {
      const { network: { remoteAddress = '' } = {} } = peers[peerId];
      const remoteIp = remoteAddress.split(':')[0];
      // TODO: enable on live
      // peers[peerId].ip_info = await augmentWithIPInfo(remoteIp);
      peers[peerId].ip_info = {
        ip: '174.92.149.225',
        hostname: 'bras-base-sconpq1802w-grc-04-174-92-149-225.dsl.bell.ca',
        city: 'Saint-Constant',
        region: 'Quebec',
        country: 'CA',
        country_name: 'Canada',
        loc: '45.3668,-73.5659',
        org: 'AS577 Bell Canada',
        postal: 'J5A',
        timezone: 'America/Toronto',
      };
    }

    // Ask node to refresh peer if it's stale
    if (shouldRefreshPeer(peers[peerId]) && peerDebugInfo[peerId].bootnode) {
      requestNodeToRefreshPeer(
        peers[peerId].enode,
        peerDebugInfo[peerId].bootnode
      );
      peer = setContactToNowFor('refresh', peer);
    }

    // Delete peer if it's stale for longer from cache
    if (shouldDeletePeer(peers[peerId])) {
      delete peers[peerId];
      delete peerDebugInfo[peerId];
    }
  }

  redisClient.set(peersNodeKey, JSON.stringify(peers));
  redisClient.set(peersDebugNodeKey, JSON.stringify(peerDebugInfo));

  console.log(`Updated ${Object.keys(peers).length} peers`);

  return peers;
};

router.get('/peers', async (req, res) => {
  let cachedPeers = await redisClient.get(peersNodeKey);
  if (cachedPeers) {
    peers = JSON.parse(cachedPeers);
  } else {
    try {
      peers = await updatePeers();
    } catch (err) {
      console.error(`Error retrieving peers:`, err);
      return res.status(500);
    }
  }

  res.json(Object.values(peers));
});

updatePeers();
// update Peers every hour
setInterval(updatePeers, 60 * 60 * 1000);

module.exports = router;
