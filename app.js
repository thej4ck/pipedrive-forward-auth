const express = require('express');
const axios = require('axios');
const qs = require('qs');
const basicAuth = require('express-basic-auth');
const { setTimeout } = require('timers/promises');

const {
  MAILUP_CLIENT_ID,
  MAILUP_CLIENT_SECRET,
  MAILUP_USERNAME,
  MAILUP_PASSWORD,
  WEBHOOK_BASE_PATH = 'webhook/person/detail/',
  FORWARD_AUTH_URL = 'http://forward-auth:4000',
  BASIC_AUTH_USER,
  BASIC_AUTH_PASS,
  MAX_FIELD_LENGTH = 40
} = process.env;

if (!BASIC_AUTH_USER || !BASIC_AUTH_PASS) {
  console.error('BASIC_AUTH_USER and BASIC_AUTH_PASS must be set');
  process.exit(1);
}

const app = express();
const PORT = process.env.PORT || 3000;

let mailupAccessToken = '';
let mailupTokenExpiry = null;
const messagesCache = {};

const authMiddleware = basicAuth({
  users: { [BASIC_AUTH_USER]: BASIC_AUTH_PASS },
  challenge: true,
  realm: 'Pipedrive-MailUp Integration'
});

function log(context, message, data = null) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${context}] ${message}`);
  if (data) {
    console.log(JSON.stringify(data, null, 2));
  }
}

function truncateText(text, maxLength = MAX_FIELD_LENGTH) {
  if (!text) return '';
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - 3) + '...';
}

function getTagColor(views, clicks) {
  if (views === 0 && clicks === 0) return "red";
  if (views > 0 && clicks === 0) return "yellow";
  return "blue";
}

function cleanHtmlContent(html) {
  let text = html.replace(/<img[^>]*>/g, '')
                 .replace(/<a[^>]*>(.*?)<\/a>/g, '$1');
  
  text = text.replace(/<[^>]*>/g, ' ');
  
  text = text.replace(/&nbsp;/g, ' ')
             .replace(/&amp;/g, '&')
             .replace(/&lt;/g, '<')
             .replace(/&gt;/g, '>')
             .replace(/&quot;/g, '"')
             .replace(/&#39;/g, "'")
             .replace(/&rsquo;/g, "'")
             .replace(/&lsquo;/g, "'")
             .replace(/&rdquo;/g, '"')
             .replace(/&ldquo;/g, '"')
             .replace(/&hellip;/g, '...')
             .replace(/&mdash;/g, '-')
             .replace(/&ndash;/g, '-')
             .replace(/&bull;/g, '•');
             
  text = text.replace(/\s+/g, ' ').trim();
  
  return truncateText(text);
}

async function getMailUpAccessToken() {
  log('MailUp', 'Requesting new access token');
  const tokenUrl = 'https://services.mailup.com/Authorization/OAuth/Token';
  const authHeader = Buffer.from(`${MAILUP_CLIENT_ID}:${MAILUP_CLIENT_SECRET}`).toString('base64');
  
  try {
    const response = await axios.post(tokenUrl, 
      qs.stringify({
        grant_type: 'password',
        username: MAILUP_USERNAME,
        password: MAILUP_PASSWORD,
      }), {
        headers: {
          Authorization: `Basic ${authHeader}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      }
    );
    
    mailupAccessToken = response.data.access_token;
    mailupTokenExpiry = Date.now() + response.data.expires_in * 1000;
    log('MailUp', 'Access token obtained successfully', { expires_in: response.data.expires_in });
  } catch (error) {
    log('MailUp', 'Error getting access token', { error: error.message });
    throw error;
  }
}

async function getMessageDetails(idMessage) {
  log('MailUp', `Getting message details for ID: ${idMessage}`);
  
  if (messagesCache[idMessage]) {
    log('MailUp', `Cache hit for message ID: ${idMessage}`);
    return messagesCache[idMessage];
  }

  if (!mailupAccessToken || Date.now() >= mailupTokenExpiry) {
    log('MailUp', 'Token expired, refreshing');
    await getMailUpAccessToken();
  }

  await setTimeout(200);

  try {
    const response = await axios.get(
      `https://services.mailup.com/API/v1.1/Rest/ConsoleService.svc/Console/List/1/Email/${idMessage}`,
      {
        headers: { Authorization: `Bearer ${mailupAccessToken}` }
      }
    );

    const cleanContent = cleanHtmlContent(response.data.Content);
    
    messagesCache[idMessage] = {
      id: idMessage,
      header: truncateText(response.data.Subject),
      content: cleanContent
    };

    log('MailUp', `Message details retrieved for ID: ${idMessage}`, { subject: response.data.Subject });
    return messagesCache[idMessage];
  } catch (error) {
    log('MailUp', `Error getting message details for ID: ${idMessage}`, { error: error.message });
    throw error;
  }
}

async function getEmailStats(email) {
  log('MailUp', `Getting stats for email: ${email}`);

  if (!mailupAccessToken || Date.now() >= mailupTokenExpiry) {
    await getMailUpAccessToken();
  }

  try {
    const recipientResponse = await axios.get(
      `https://services.mailup.com/API/v1.1/Rest/ConsoleService.svc/Console/Recipients?email="${encodeURIComponent(email)}"`,
      {
        headers: { Authorization: `Bearer ${mailupAccessToken}` }
      }
    );

    if (!recipientResponse.data.Items?.length) {
      log('MailUp', `No recipient found for email: ${email}`);
      return [];
    }

    const recipientId = recipientResponse.data.Items[0].idRecipient;
    log('MailUp', `Found recipient ID: ${recipientId} for email: ${email}`);

    const [opensResponse, clicksResponse] = await Promise.all([
      axios.get(
        `https://services.mailup.com/API/v1.1/Rest/MailStatisticsService.svc/Recipient/${recipientId}/List/Views?orderby="IdMessage+desc"&PageSize=10`,
        { headers: { Authorization: `Bearer ${mailupAccessToken}` } }
      ),
      axios.get(
        `https://services.mailup.com/API/v1.1/Rest/MailStatisticsService.svc/Recipient/${recipientId}/List/Clicks?orderby="IdMessage+desc"&PageSize=10`,
        { headers: { Authorization: `Bearer ${mailupAccessToken}` } }
      )
    ]);

    const messagesMap = {};

    opensResponse.data.Items.forEach(item => {
      messagesMap[item.IdMessage] = {
        id: item.IdMessage,
        header: truncateText(item.Subject),
        views: item.Count,
        clicks: 0
      };
    });

    clicksResponse.data.Items.forEach(item => {
      if (messagesMap[item.IdMessage]) {
        messagesMap[item.IdMessage].clicks = item.Count;
      } else {
        messagesMap[item.IdMessage] = {
          id: item.IdMessage,
          header: truncateText(item.Subject),
          views: 0,
          clicks: item.Count
        };
      }
    });

    log('MailUp', `Stats retrieved for email: ${email}`, { 
      messageCount: Object.keys(messagesMap).length,
      totalViews: Object.values(messagesMap).reduce((sum, msg) => sum + msg.views, 0),
      totalClicks: Object.values(messagesMap).reduce((sum, msg) => sum + msg.clicks, 0)
    });

    return Object.values(messagesMap);
  } catch (error) {
    log('MailUp', `Error getting stats for email: ${email}`, { error: error.message });
    throw error;
  }
}

app.get(`/${WEBHOOK_BASE_PATH}`, authMiddleware, async (req, res) => {
  const requestId = Math.random().toString(36).substring(7);
  log('Webhook', `Received request ${requestId}`, req.query);

  try {
    const { resource, view, userId, companyId, selectedIds } = req.query;

    if (resource !== 'person' || view !== 'details') {
      log('Webhook', `Invalid request type ${requestId}`, { resource, view });
      return res.status(400).json({ error: 'Invalid request type' });
    }

    log('Pipedrive', `Getting token for user ${userId} company ${companyId}`);
    const tokenResponse = await axios.get(`${FORWARD_AUTH_URL}/token/${userId}/${companyId}`);
    log('Pipedrive', 'Token response:', tokenResponse.data);

    const userKey = `${companyId}_${userId}`;
    const tokenData = tokenResponse.data;
    
    if (!tokenData || !tokenData.access_token || !tokenData.api_domain) {
      log('Pipedrive', 'Invalid token data', tokenData);
      return res.status(500).json({ error: 'Invalid token data' });
    }

    const { access_token, api_domain } = tokenData;
    log('Pipedrive', 'Token data extracted', { api_domain });

    log('Pipedrive', `Getting person details for ID: ${selectedIds}`);
    const personResponse = await axios.get(`${api_domain}/api/v2/persons/${selectedIds}`, {
      headers: { Authorization: `Bearer ${access_token}` }
    });

    const emails = personResponse.data.data.emails
      .map(email => email.value)
      .filter(Boolean);

    log('Pipedrive', `Found ${emails.length} emails for person ${selectedIds}`, { emails });

    if (!emails.length) {
      log('Webhook', `No emails found for request ${requestId}`);
      return res.json({ data: [] });
    }

    const allStats = await Promise.all(emails.map(getEmailStats));
    const mergedStats = allStats.flat().reduce((acc, stat) => {
      const existing = acc.find(s => s.id === stat.id);
      if (existing) {
        existing.views += stat.views;
        existing.clicks += stat.clicks;
      } else {
        acc.push(stat);
      }
      return acc;
    }, []);

    const sortedStats = mergedStats
      .sort((a, b) => b.id - a.id)
      .slice(0, 10);

    log('Webhook', `Processing ${sortedStats.length} messages for request ${requestId}`);

    const finalStats = await Promise.all(
      sortedStats.map(async stat => {
        const details = await getMessageDetails(stat.id);
        return {
          id: stat.id,
          header: truncateText(details.header),
          title: truncateText(details.header),
          views: stat.views,
          clicks: stat.clicks,
          tag: {
            color: getTagColor(stat.views, stat.clicks),
            label: `V${stat.views}C${stat.clicks}`
          },
          Anteprima: {
            markdown: true,
            value: details.content
          }
        };
      })
    );

    log('Webhook', `Request ${requestId} completed successfully`, { 
      messageCount: finalStats.length,
      messageIds: finalStats.map(stat => stat.id)
    });

    res.json({ data: finalStats });
  } catch (error) {
    log('Webhook', `Error processing request ${requestId}`, { 
      error: error.message,
      stack: error.stack
    });
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  log('Server', `Running on port ${PORT}`);
  log('Server', `Webhook path: /${WEBHOOK_BASE_PATH}`);
  log('Server', `Maximum field length: ${MAX_FIELD_LENGTH} characters`);
});
