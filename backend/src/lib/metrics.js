const processStartedAt = new Date().toISOString();
const counters = {
  totalRequests: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
  queueFailures: 0,
};

function recordRequestStatus(status) {
  counters.totalRequests += 1;
  if (status >= 200 && status < 300) counters.status2xx += 1;
  else if (status >= 300 && status < 400) counters.status3xx += 1;
  else if (status >= 400 && status < 500) counters.status4xx += 1;
  else if (status >= 500) counters.status5xx += 1;
}

function recordQueueFailure() {
  counters.queueFailures += 1;
}

function snapshotMetrics() {
  return {
    scope: 'this process since start',
    processStartedAt,
    totalRequests: counters.totalRequests,
    statusClasses: {
      '2xx': counters.status2xx,
      '3xx': counters.status3xx,
      '4xx': counters.status4xx,
      '5xx': counters.status5xx,
    },
    queueFailures: counters.queueFailures,
  };
}

module.exports = { recordRequestStatus, recordQueueFailure, snapshotMetrics };
