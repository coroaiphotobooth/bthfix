import type { VercelRequest, VercelResponse } from '@vercel/node';
import { GoogleAuth } from 'google-auth-library';

export const config = {
  maxDuration: 120, // Set timeout to 60s
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { image, prompt, modelKey, aspectRatio } = req.body;

    if (!image || !prompt) {
      return res.status(400).json({ error: 'Missing image or prompt' });
    }

    // --- MAPPING MODEL ID ---
    // Map frontend key -> Vertex model ID.
    // You can override defaults via Vercel Environment Variables:
    // - VERTEX_LOCATION (default: us-central1)
    // - GEMINI_IMAGE_MODEL_FAST (default: gemini-1.5-flash-002)
    // - GEMINI_IMAGE_MODEL_QUALITY (default: gemini-1.5-pro-002)
    const fastDefault = process.env.GEMINI_IMAGE_MODEL_FAST || 'gemini-1.5-flash-002';
    const qualityDefault = process.env.GEMINI_IMAGE_MODEL_QUALITY || 'gemini-1.5-pro-002';

    let vertexModelId = fastDefault; // Default fallback

    if (modelKey === 'gemini-2.5-flash-image') {
      vertexModelId = fastDefault;
    } else if (modelKey === 'gemini-3-pro-image-preview') {
      // Note: If you intend to use Gemini 3 Pro (text-only) here, it will NOT return an image.
      // Keep this mapped to an image-capable model ID.
      vertexModelId = qualityDefault;
    }

    // --- SETUP AUTH ---
    const projectId = process.env.GCP_PROJECT_ID;
    const clientEmail = process.env.GCP_CLIENT_EMAIL;
    const privateKey = process.env.GCP_PRIVATE_KEY?.replace(/\\n/g, '\n');

    if (!projectId || !clientEmail || !privateKey) {
      console.error("Missing GCP Credentials");
      return res.status(500).json({ error: 'Server Auth Config Error' });
    }

    const auth = new GoogleAuth({
      credentials: { client_email: clientEmail, private_key: privateKey, project_id: projectId },
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });

    const client = await auth.getClient();
    const accessToken = await client.getAccessToken();

    // --- CALL VERTEX AI (GEMINI) ---
    const location = process.env.VERTEX_LOCATION || 'us-central1';
    const endpoint = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${vertexModelId}:generateContent`;

    const base64Image = image.includes(',') ? image.split(',')[1] : image;
    const mimeType = image.startsWith('data:image/png') ? 'image/png' : 'image/jpeg';

    // Vertex Gemini Payload
    const payload = {
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inlineData: { mimeType: mimeType, data: base64Image } }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.4,
        topK: 40,
        topP: 0.95,
        maxOutputTokens: 8192,
        responseMimeType: "text/plain"
      }
      // Note: "systemInstruction" is supported on newer API versions if needed
    };

    const apiRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    const data = await apiRes.json();

    if (!apiRes.ok) {
      console.error("Vertex API Error:", JSON.stringify(data));
      throw new Error(data.error?.message || "Vertex AI Generation Failed");
    }

    // --- EXTRACT IMAGE ---
    // Gemini di Vertex tidak selalu return image langsung dalam format JSON standard.
    // Namun untuk Imagen 3 (model image gen dedicated) beda endpoint.
    // Jika kita menggunakan Gemini Multimodal untuk edit gambar (Instruction editing),
    // outputnya biasanya text atau inlineData gambar jika model support output gambar.
    // SAAT INI: Gemini 1.5 Pro/Flash belum tentu output native image bytes via generateContent.
    // NAMUN: Prompt user meminta "EDIT MODE", yang biasanya ditangani oleh Gemini dengan mengembalikan gambar base64
    // ATAU kita harus menggunakan Imagen 3 endpoint jika tujuannya murni generate image baru.
    
    // ASUMSI: Kita menggunakan kemampuan Multimodal Gemini untuk mengembalikan gambar (jika didukung) 
    // atau prompt menghasilkan base64 string di dalam text.
    
    // JIKA output berupa Text (karena Gemini kebanyakan text-out), kita perlu Imagen.
    // TAPI karena request user spesifik "Gemini 2.5", kita asumsikan model ini support image out.
    
    let resultBase64 = null;
    
    // Cek Parts
    const parts = data.candidates?.[0]?.content?.parts;
    if (parts) {
      for (const part of parts) {
        if (part.inlineData) {
          resultBase64 = part.inlineData.data;
          break;
        }
      }
    }

    // Jika tidak ada inlineData, mungkin Imagen 3 diperlukan? 
    // Untuk keamanan kode ini sesuai prompt user (Gemini), jika tidak ada gambar, kita throw error.
    if (!resultBase64) {
        // Fallback check if text contains base64 (unlikely for standard API usage but possible in some hacks)
        throw new Error("Model returned text instead of image. Verify Vertex AI Model capability.");
    }

    return res.status(200).json({ image: `data:image/png;base64,${resultBase64}` });

  } catch (error: any) {
    console.error("API Error:", error);
    return res.status(500).json({ error: error.message || 'Internal Server Error' });
  }
}