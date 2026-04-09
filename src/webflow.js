const WEBFLOW_API = 'https://api.webflow.com/v2';
const RATE_LIMIT_DELAY_MS = 1100; // Stay under 60 req/min
const TRANSIENT_STATUS_CODES = new Set([502, 503, 504]);
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5000; // 5s, 10s, 20s exponential backoff

class WebflowClient {
  constructor(apiToken, siteId) {
    this.apiToken = apiToken;
    this.siteId = siteId;
    this.lastRequestTime = 0;
  }

  async request(method, path, body = null, _retryCount = 0) {
    // Simple rate limiter
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < RATE_LIMIT_DELAY_MS) {
      await sleep(RATE_LIMIT_DELAY_MS - elapsed);
    }
    this.lastRequestTime = Date.now();

    const url = `${WEBFLOW_API}${path}`;
    const options = {
      method,
      headers: {
        'Authorization': `Bearer ${this.apiToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    };
    if (body) options.body = JSON.stringify(body);

    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      // Network-level failure (DNS, connection reset, etc.)
      if (_retryCount < MAX_RETRIES) {
        const delay = RETRY_BASE_DELAY_MS * Math.pow(2, _retryCount);
        console.warn(`[webflow] Network error: ${networkErr.message}. Retrying in ${delay / 1000}s (attempt ${_retryCount + 1}/${MAX_RETRIES})...`);
        await sleep(delay);
        return this.request(method, path, body, _retryCount + 1);
      }
      throw networkErr;
    }

    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      console.warn(`[webflow] Rate limited. Retrying in ${retryAfter}s...`);
      await sleep(retryAfter * 1000);
      return this.request(method, path, body, 0);
    }

    // Retry on transient server errors (502, 503, 504)
    if (TRANSIENT_STATUS_CODES.has(res.status) && _retryCount < MAX_RETRIES) {
      const delay = RETRY_BASE_DELAY_MS * Math.pow(2, _retryCount);
      console.warn(`[webflow] ${res.status} on ${method} ${path}. Retrying in ${delay / 1000}s (attempt ${_retryCount + 1}/${MAX_RETRIES})...`);
      await sleep(delay);
      return this.request(method, path, body, _retryCount + 1);
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Webflow API ${method} ${path} returned ${res.status}: ${text}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return null;
  }

  async getAllCollectionItems(collectionId) {
    console.log('[webflow] Fetching all CMS items...');
    const items = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const data = await this.request('GET',
        `/collections/${collectionId}/items?limit=${limit}&offset=${offset}`
      );
      if (data.items) items.push(...data.items);
      if (!data.items || data.items.length < limit) break;
      offset += limit;
      console.log(`[webflow] Fetched ${items.length} items so far...`);
    }

    console.log(`[webflow] Total CMS items: ${items.length}`);
    return items;
  }

  async createItems(collectionId, items) {
    const BATCH_SIZE = 5;
    const created = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        const result = await this.request('POST',
          `/collections/${collectionId}/items`,
          { items: batch }
        );
        if (result.items) created.push(...result.items);
        console.log(`[webflow] Created batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} items`);
      } catch (err) {
        // If batch fails, try items individually
        console.warn(`[webflow] Batch create failed, trying individually: ${err.message.substring(0, 500)}`);
        for (const item of batch) {
          try {
            const result = await this.request('POST',
              `/collections/${collectionId}/items`,
              { items: [item] }
            );
            if (result.items) created.push(...result.items);
          } catch (innerErr) {
            console.error(`[webflow] Failed to create item "${item.fieldData?.name}": ${innerErr.message.substring(0, 500)}`);
          }
        }
      }
    }
    return created;
  }

  async updateItems(collectionId, items) {
    const BATCH_SIZE = 5;
    const updated = [];

    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        const result = await this.request('PATCH',
          `/collections/${collectionId}/items`,
          { items: batch }
        );
        if (result.items) updated.push(...result.items);
        console.log(`[webflow] Updated batch ${Math.floor(i / BATCH_SIZE) + 1}: ${batch.length} items`);
      } catch (err) {
        // If batch fails, try items individually
        console.warn(`[webflow] Batch update failed, trying individually: ${err.message.substring(0, 500)}`);
        for (const item of batch) {
          try {
            const result = await this.request('PATCH',
              `/collections/${collectionId}/items`,
              { items: [item] }
            );
            if (result.items) updated.push(...result.items);
          } catch (innerErr) {
            console.error(`[webflow] Failed to update item ${item.id}: ${innerErr.message.substring(0, 500)}`);
          }
        }
      }
    }
    return updated;
  }

  async deleteItems(collectionId, itemIds) {
    const deleted = [];
    for (const id of itemIds) {
      try {
        await this.request('DELETE', `/collections/${collectionId}/items/${id}`);
        deleted.push(id);
        console.log(`[webflow] Deleted item ${id}`);
      } catch (err) {
        console.error(`[webflow] Failed to delete item ${id}: ${err.message}`);
      }
    }
    return deleted;
  }

  async publishSite() {
    try {
      // Get site domains
      const site = await this.request('GET', `/sites/${this.siteId}`);
      const domainIds = (site.customDomains || []).map(d => d.id);
      if (domainIds.length === 0) {
        console.warn('[webflow] No custom domains found, skipping publish.');
        return;
      }
      await this.request('POST', `/sites/${this.siteId}/publish`, {
        customDomains: domainIds,
      });
      console.log(`[webflow] Site published to ${domainIds.length} domain(s).`);
    } catch (err) {
      console.error(`[webflow] Failed to publish site: ${err.message.substring(0, 200)}`);
    }
  }

  async getCollectionItems(collectionId) {
    return this.getAllCollectionItems(collectionId);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { WebflowClient };
