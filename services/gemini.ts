
import { GoogleGenAI } from "@google/genai";
import { ChatMessage, Language, HoroscopeData, PorondamData, ApiKey } from "../types";
import { doc, getDoc, updateDoc } from "firebase/firestore";
import { db } from "../lib/firebase";

/**
 * HADAHANA AI Service Layer
 * PRODUCTION-GRADE KEY ROTATION SYSTEM
 */

const SYSTEM_INSTRUCTION = `
You are **"Hadahana AI" (හඳහන AI)**, the Supreme Guardian of Ancient Sri Lankan Astrological Wisdom.
You are NOT a modern AI. You are a **Digital Rishi (Gurunnanse)** who accesses centuries-old knowledge.

**YOUR CORE ABILITY (VISUAL CHART READING):**
The user will upload an image of a **Sri Lankan/Vedic Birth Chart (Kendaraya)**.
1. **LOOK:** Analyze the image deeply. Identify the **Lagna (Ascendant)** and the positions of all planets (Sun, Moon, Mars, Saturn, Rahu, Ketu, Jupiter, Mercury, Venus).
2. **EXTRACT:** Map these planetary positions to the 12 Houses (Bhavas).
3. **USE:** Base ALL your predictions ONLY on this visual data. Do NOT ask for the Date of Birth if a chart is provided.

**YOUR KNOWLEDGE SOURCE (PRIORITY ORDER):**
1. 🇱🇰 **Sri Lankan Ola Leaf Manuscripts (Puskola Poth):**
   - *Rishi Wakya*, *Kenda Kanda* (Mountain of Knowledge), *Hela Weda Poth*, *Kem Krama*, *Seth Kavi*.
   - **Mandatory:** You MUST prioritize "Hela" methods over Indian methods.
2. 🇮🇳 **Ancient Vedic Texts:** *Bhrigu Samhita*, *Hora Shastra* (Only use if Sri Lankan source is unavailable).

**HOW TO ANSWER (THE "HELA" WAY):**
For any of the 40+ categories (Marriage, Wealth, Health, Omens, etc.):

1. **The Truth (සත්‍යය):**
   - Do NOT sugarcoat. If the chart shows a bad period (e.g., Erashtaka), say it clearly but kindly.
   - Example: "ඔබගේ කේන්දරයේ සෙනසුරු 8 වැන්නේ ගමන් කිරීම නිසා මෙය අපල කාලයකි."

2. **The Ancient Reference (පුස්කොල පොත් සාක්ෂිය):**
   - Quote the ancient logic.
   - Example: "පෞරාණික 'ග්‍රහ භාව ප්‍රකාශ' පුස්කොල පොතේ සඳහන් වන පරිදි..."

3. **The Solution (කෙම් ක්‍රම & ශාන්ති කර්ම):**
   - Provide "Hela" remedies. NOT just prayers.
   - **Wealth:** Suggest specific Kem methods (e.g., using turmeric water, specific coins).
   - **Protection:** Suggest specific "Seth Kavi" or "Bodhi Pooja" (tell them specifically which color flowers, which direction to look).
   - **Health:** Suggest traditional "Ath Beheth" (Home remedies) found in Hela Wedakama.

**STRICT RULES:**
- **Language:** Dignified, Mystical Sinhala (use terms like 'ඔබ තුමා/තුමිය', 'ග්‍රහ දෝෂ', 'නැකැත්').
- **No Hallucinations:** If the chart image is too blurry to read, politely ask them to upload a clearer photo. Do NOT guess.
- **Scope:** You cover EVERYTHING: Porondam, Vastu, Lizard Omens, Dreams, Palmistry (if hand photo given), and Gemstones.
- **Response Format:** You must output your response in VALID HTML using the specified structure (<div class="response-card">...).

"මම හුදෙක් පරිගණක වැඩසටහනක් නොව, හෙළ බොදු අස්වැද්දුමෙන් පෝෂණය වූ ඩිජිටල් ගුරුන්නාන්සේ කෙනෙකි."
`;

// --- KEY MANAGEMENT LOGIC ---

// Helper: Fetch all keys from Firestore
const getAllKeys = async (): Promise<ApiKey[]> => {
  try {
    const docRef = doc(db, "settings", "global_config");
    const docSnap = await getDoc(docRef);
    if (docSnap.exists() && docSnap.data().apiKeys) {
      return docSnap.data().apiKeys as ApiKey[];
    }
    return [];
  } catch (error) {
    console.error("Failed to fetch API keys", error);
    return [];
  }
};

// Helper: Select the best available key (Load Balancing Strategy: Least Recently Used)
const getBestApiKey = async (): Promise<ApiKey | null> => {
  const allKeys = await getAllKeys();
  const now = Date.now();

  // Filter for Active keys that are NOT in cooldown
  const availableKeys = allKeys.filter(k => 
    k.status === 'active' && 
    (!k.reactivateAt || k.reactivateAt <= now)
  );

  if (availableKeys.length === 0) return null;

  // Sort by Last Used (Ascending) -> Pick the one used longest ago
  availableKeys.sort((a, b) => {
    const timeA = a.lastUsedAt ? new Date(a.lastUsedAt).getTime() : 0;
    const timeB = b.lastUsedAt ? new Date(b.lastUsedAt).getTime() : 0;
    return timeA - timeB;
  });

  return availableKeys[0];
};

// Helper: Update key usage stats (Usage Count + Last Used Time)
const updateKeySuccess = async (targetKey: string) => {
  try {
    // Note: We read-modify-write here. In high concurrency, Firestore transactions are better,
    // but for this scale, this logic is sufficient.
    const docRef = doc(db, "settings", "global_config");
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return;

    const currentKeys = docSnap.data().apiKeys as ApiKey[];
    const updatedKeys = currentKeys.map(k => {
      if (k.key === targetKey) {
        return {
          ...k,
          lastUsedAt: new Date().toISOString(),
          usageCount: (k.usageCount || 0) + 1,
          reactivateAt: null // Clear any cooldown
        };
      }
      return k;
    });

    await updateDoc(docRef, { apiKeys: updatedKeys });
  } catch (e) {
    console.warn("Could not update key usage stats (likely permission issue for non-admin)", e);
  }
};

// Helper: Handle Rate Limit (429) - Set Cooldown
const handleKeyRateLimited = async (targetKey: string) => {
  console.warn(`Key ${targetKey.slice(0,4)}... hit Rate Limit (429). Setting cooldown.`);
  try {
    const docRef = doc(db, "settings", "global_config");
    const docSnap = await getDoc(docRef);
    if (!docSnap.exists()) return;

    const currentKeys = docSnap.data().apiKeys as ApiKey[];
    const updatedKeys = currentKeys.map(k => {
      if (k.key === targetKey) {
        return {
          ...k,
          // Set cooldown for 60 seconds
          reactivateAt: Date.now() + 60000 
        };
      }
      return k;
    });

    await updateDoc(docRef, { apiKeys: updatedKeys });
  } catch (e) {
    console.warn("Could not set key cooldown (likely permission issue)", e);
  }
};

/**
 * GENERIC EXECUTION WRAPPER
 * Handles Key Selection, Rotation, and Retries automatically.
 */
async function withKeyRotation<T>(
  operation: (ai: GoogleGenAI) => Promise<T>,
  attempt = 1
): Promise<T> {
  // 1. Get Key
  const apiKeyData = await getBestApiKey();
  
  if (!apiKeyData) {
    // Fallback to env if no DB keys
    if (process.env.API_KEY) {
       const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
       return operation(ai);
    }
    throw new Error("Service Overloaded: No available API keys found.");
  }

  const ai = new GoogleGenAI({ apiKey: apiKeyData.key });

  try {
    // 2. Try Operation
    const result = await operation(ai);
    
    // 3. Success - Update Stats
    updateKeySuccess(apiKeyData.key);
    return result;

  } catch (error: any) {
    // 4. Error Handling
    
    // Check for Rate Limit (429) or Quota Exceeded
    if (error.message?.includes('429') || error.message?.includes('429') || error.status === 429) {
      // Mark this key as 'cooldown'
      await handleKeyRateLimited(apiKeyData.key);
      
      // Recursive Retry with next key
      if (attempt < 5) {
        console.log(`Retrying operation with new key (Attempt ${attempt + 1})...`);
        return withKeyRotation(operation, attempt + 1);
      }
    }

    throw error;
  }
}

// --- EXPORTED FUNCTIONS (Wrapped) ---

export const analyzeHoroscopeAdvanced = async (
  images: string[],
  userMessage: string,
  history: ChatMessage[],
  outputLang: Language
): Promise<string> => {
  return withKeyRotation(async (ai) => {
    
    // Prepare history
    const contents = history.map(msg => ({
      role: msg.role,
      parts: [
        { text: msg.text },
        ...(msg.images || []).map(img => ({
          inlineData: {
            mimeType: 'image/jpeg',
            data: img.split(',')[1],
          },
        }))
      ]
    }));

    // Prepare current message
    const currentParts: any[] = [];
    if (images.length > 0) {
      images.forEach(img => {
        currentParts.push({
          inlineData: {
            mimeType: 'image/jpeg',
            data: img.split(',')[1],
          },
        });
      });
    }
    
    const langInstruction = outputLang === 'si' 
      ? "භාෂාව: කරුණාකර 'පිරිසිදු සිංහල' භාෂාවෙන් (Formal Sinhala) පිළිතුරු දෙන්න." 
      : "Language: Please respond in English, but maintain the highly respectful, spiritual, and professional 'Guru' tone.";

    const now = new Date();
    const systemContext = `[SYSTEM_DATA]: CURRENT_DATE = ${now.toLocaleDateString('si-LK')}, TIME = ${now.toLocaleTimeString('si-LK')}`;

    currentParts.push({ 
      text: `${systemContext}\n\n${langInstruction}\n\nපරිශීලකයාගේ වත්මන් පණිවිඩය: ${userMessage}` 
    });

    contents.push({ role: 'user', parts: currentParts });

    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: contents,
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature: 0.5,
        topP: 0.95,
        topK: 40,
      }
    });

    let cleanText = response.text || "සන්නිවේදනයේ දෝෂයක් ඇති විය.";
    cleanText = cleanText.replace(/```html/g, '').replace(/```/g, '');
    return cleanText;
  });
};

export const getHoroscopeReading = async (data: HoroscopeData, lang: Language): Promise<string> => {
  return withKeyRotation(async (ai) => {
    const langInstruction = lang === 'si' ? "Sinhala" : "English";
    const prompt = `Language: ${langInstruction}\n\nPerform a full horoscope reading based on:\nDOB: ${data.dob}\nTime: ${data.tob}\nPlace: ${data.pob}\n\nIMPORTANT: Respond in valid HTML using the specified classes.`;
    
    const response = await ai.models.generateContent({ 
      model: 'gemini-3-flash-preview', 
      contents: prompt,
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
    return (response.text || "Reading failed.").replace(/```html/g, '').replace(/```/g, '');
  });
};

export const getPorondamReading = async (data: PorondamData, lang: Language): Promise<string> => {
  return withKeyRotation(async (ai) => {
    const langInstruction = lang === 'si' ? "Sinhala" : "English";
    const prompt = `Language: ${langInstruction}\n\nCheck Porondam compatibility for:\nGroom: ${data.groomName} (${data.groomNakshatra})\nBride: ${data.brideName} (${data.brideNakshatra})\n\nIMPORTANT: Respond in valid HTML using the specified classes.`;
    
    const response = await ai.models.generateContent({ 
      model: 'gemini-3-flash-preview', 
      contents: prompt,
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
    return (response.text || "Compatibility check failed.").replace(/```html/g, '').replace(/```/g, '');
  });
};

export const analyzeAncientManuscript = async (image: string, lang: Language): Promise<string> => {
  return withKeyRotation(async (ai) => {
    const langInstruction = lang === 'si' ? "Sinhala" : "English";
    const response = await ai.models.generateContent({
      model: 'gemini-3-flash-preview',
      contents: {
        parts: [
          { inlineData: { mimeType: 'image/jpeg', data: image.split(',')[1] } },
          { text: `Language: ${langInstruction}\n\nAnalyze this manuscript.\nIMPORTANT: Respond in valid HTML using the specified classes.` }
        ]
      },
      config: { systemInstruction: SYSTEM_INSTRUCTION }
    });
    return (response.text || "Manuscript analysis failed.").replace(/```html/g, '').replace(/```/g, '');
  });
};
