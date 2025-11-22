import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai"
import OpenAI from "openai"
import fs from "fs"
import path from "path"
import os from "os"

interface OllamaResponse {
  response: string
  done: boolean
}

type ProviderType = "gemini" | "ollama" | "openai"

export class LLMHelper {
  private model: GenerativeModel | null = null
  private openaiClient: OpenAI | null = null
  private readonly systemPrompt = `You are a helpful AI assistant. Provide clear, direct, and concise answers to user questions. Be helpful and accurate.`
  private provider: ProviderType = "gemini"
  private useOllama: boolean = false
  private ollamaModel: string = "llama3.2"
  private ollamaUrl: string = "http://localhost:11434"
  private openaiModel: string = "gpt-4o"

  constructor(apiKey?: string, useOllama: boolean = false, ollamaModel?: string, ollamaUrl?: string, useOpenAI: boolean = false) {
    this.useOllama = useOllama
    
    if (useOllama) {
      this.provider = "ollama"
      this.ollamaUrl = ollamaUrl || "http://localhost:11434"
      this.ollamaModel = ollamaModel || "gemma:latest" // Default fallback
      console.log(`[LLMHelper] Using Ollama with model: ${this.ollamaModel}`)
      
      // Auto-detect and use first available model if specified model doesn't exist
      this.initializeOllamaModel()
    } else if (useOpenAI && apiKey) {
      this.provider = "openai"
      this.openaiClient = new OpenAI({ apiKey })
      console.log("[LLMHelper] Using OpenAI")
    } else if (apiKey) {
      this.provider = "gemini"
      const genAI = new GoogleGenerativeAI(apiKey)
      this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" })
      console.log("[LLMHelper] Using Google Gemini")
    } else {
      throw new Error("Either provide API key (Gemini/OpenAI) or enable Ollama mode")
    }
  }

  private async fileToGenerativePart(imagePath: string) {
    const imageData = await fs.promises.readFile(imagePath)
    return {
      inlineData: {
        data: imageData.toString("base64"),
        mimeType: "image/png"
      }
    }
  }

  private cleanJsonResponse(text: string): string {
    // Remove markdown code block syntax if present
    text = text.replace(/^```(?:json)?\n/, '').replace(/\n```$/, '');
    // Remove any leading/trailing whitespace
    text = text.trim();
    return text;
  }

  private async callOllama(prompt: string): Promise<string> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.ollamaModel,
          prompt: prompt,
          stream: false,
          options: {
            temperature: 0.7,
            top_p: 0.9,
          }
        }),
      })

      if (!response.ok) {
        throw new Error(`Ollama API error: ${response.status} ${response.statusText}`)
      }

      const data: OllamaResponse = await response.json()
      return data.response
    } catch (error) {
      console.error("[LLMHelper] Error calling Ollama:", error)
      throw new Error(`Failed to connect to Ollama: ${error.message}. Make sure Ollama is running on ${this.ollamaUrl}`)
    }
  }

  private async checkOllamaAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`)
      return response.ok
    } catch {
      return false
    }
  }

  private async initializeOllamaModel(): Promise<void> {
    try {
      const availableModels = await this.getOllamaModels()
      if (availableModels.length === 0) {
        console.warn("[LLMHelper] No Ollama models found")
        return
      }

      // Check if current model exists, if not use the first available
      if (!availableModels.includes(this.ollamaModel)) {
        this.ollamaModel = availableModels[0]
        console.log(`[LLMHelper] Auto-selected first available model: ${this.ollamaModel}`)
      }

      // Test the selected model works
      const testResult = await this.callOllama("Hello")
      console.log(`[LLMHelper] Successfully initialized with model: ${this.ollamaModel}`)
    } catch (error) {
      console.error(`[LLMHelper] Failed to initialize Ollama model: ${error.message}`)
      // Try to use first available model as fallback
      try {
        const models = await this.getOllamaModels()
        if (models.length > 0) {
          this.ollamaModel = models[0]
          console.log(`[LLMHelper] Fallback to: ${this.ollamaModel}`)
        }
      } catch (fallbackError) {
        console.error(`[LLMHelper] Fallback also failed: ${fallbackError.message}`)
      }
    }
  }

  public async extractProblemFromImages(imagePaths: string[]) {
    try {
      const prompt = `${this.systemPrompt}\n\nPlease analyze these images and extract the following information in JSON format:\n{
  "problem_statement": "A clear statement of the problem or situation depicted in the images.",
  "context": "Relevant background or context from the images.",
  "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
  "reasoning": "Explanation of why these suggestions are appropriate."
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      let text: string;
      
      if (this.provider === "openai" && this.openaiClient) {
        const imageContents = await Promise.all(
          imagePaths.map(async (path) => {
            const imageData = await fs.promises.readFile(path);
            return {
              type: "image_url" as const,
              image_url: {
                url: `data:image/png;base64,${imageData.toString("base64")}`
              }
            };
          })
        );
        
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...imageContents
              ]
            }
          ],
          response_format: { type: "json_object" },
          max_tokens: 2000
        });
        text = response.choices[0]?.message?.content || "";
      } else if (this.model) {
        const imageParts = await Promise.all(imagePaths.map(path => this.fileToGenerativePart(path)));
        const result = await this.model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        text = response.text();
      } else {
        throw new Error("No LLM provider configured for image analysis");
      }
      
      const cleanedText = this.cleanJsonResponse(text);
      return JSON.parse(cleanedText);
    } catch (error) {
      console.error("Error extracting problem from images:", error);
      throw error;
    }
  }

  public async generateSolution(problemInfo: any) {
    const prompt = `${this.systemPrompt}\n\nGiven this problem or situation:\n${JSON.stringify(problemInfo, null, 2)}\n\nPlease provide your response in the following JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

    console.log(`[LLMHelper] Calling ${this.provider} LLM for solution...`);
    try {
      let text: string;
      
      if (this.provider === "openai" && this.openaiClient) {
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [
            { role: "system", content: this.systemPrompt },
            { role: "user", content: prompt }
          ],
          response_format: { type: "json_object" },
          max_tokens: 2000
        });
        text = response.choices[0]?.message?.content || "";
      } else if (this.model) {
        const result = await this.model.generateContent(prompt);
        const response = await result.response;
        text = response.text();
      } else if (this.useOllama) {
        text = await this.callOllama(prompt);
      } else {
        throw new Error("No LLM provider configured");
      }
      
      const cleanedText = this.cleanJsonResponse(text);
      const parsed = JSON.parse(cleanedText);
      console.log(`[LLMHelper] Parsed ${this.provider} LLM response:`, parsed);
      return parsed;
    } catch (error) {
      console.error(`[LLMHelper] Error in generateSolution:`, error);
      throw error;
    }
  }

  public async debugSolutionWithImages(problemInfo: any, currentCode: string, debugImagePaths: string[]) {
    try {
      const prompt = `${this.systemPrompt}\n\nGiven:\n1. The original problem or situation: ${JSON.stringify(problemInfo, null, 2)}\n2. The current response or approach: ${currentCode}\n3. The debug information in the provided images\n\nPlease analyze the debug information and provide feedback in this JSON format:\n{
  "solution": {
    "code": "The code or main answer here.",
    "problem_statement": "Restate the problem or situation.",
    "context": "Relevant background/context.",
    "suggested_responses": ["First possible answer or action", "Second possible answer or action", "..."],
    "reasoning": "Explanation of why these suggestions are appropriate."
  }
}\nImportant: Return ONLY the JSON object, without any markdown formatting or code blocks.`

      let text: string;
      
      if (this.provider === "openai" && this.openaiClient) {
        const imageContents = await Promise.all(
          debugImagePaths.map(async (path) => {
            const imageData = await fs.promises.readFile(path);
            return {
              type: "image_url" as const,
              image_url: {
                url: `data:image/png;base64,${imageData.toString("base64")}`
              }
            };
          })
        );
        
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                ...imageContents
              ]
            }
          ],
          response_format: { type: "json_object" },
          max_tokens: 2000
        });
        text = response.choices[0]?.message?.content || "";
      } else if (this.model) {
        const imageParts = await Promise.all(debugImagePaths.map(path => this.fileToGenerativePart(path)));
        const result = await this.model.generateContent([prompt, ...imageParts]);
        const response = await result.response;
        text = response.text();
      } else {
        throw new Error("No LLM provider configured for image analysis");
      }
      
      const cleanedText = this.cleanJsonResponse(text);
      const parsed = JSON.parse(cleanedText);
      console.log("[LLMHelper] Parsed debug LLM response:", parsed);
      return parsed;
    } catch (error) {
      console.error("Error debugging solution with images:", error);
      throw error;
    }
  }

  public async analyzeAudioFile(audioPath: string) {
    try {
      if (this.provider === "openai" && this.openaiClient) {
        // Use OpenAI Whisper API for transcription, then analyze the transcript
        const audioFile = fs.createReadStream(audioPath);
        const transcription = await this.openaiClient.audio.transcriptions.create({
          file: audioFile as any,
          model: "whisper-1",
        });
        
        const transcript = transcription.text;
        
        // Now analyze the transcript
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [
            { role: "system", content: "You are a helpful AI assistant. Provide clear, direct answers." },
            { role: "user", content: `Here is a transcript of an audio recording: "${transcript}". Please provide a clear, concise summary and analysis of what was said.` }
          ],
          max_tokens: 500
        });
        const text = response.choices[0]?.message?.content || "";
        return { text, timestamp: Date.now() };
      } else if (this.model) {
        const prompt = `Analyze this audio file and provide a clear, direct description. Be concise and helpful.`;
        const audioData = await fs.promises.readFile(audioPath);
        const audioPart = {
          inlineData: {
            data: audioData.toString("base64"),
            mimeType: "audio/mp3"
          }
        };
        const result = await this.model.generateContent([prompt, audioPart]);
        const response = await result.response;
        const text = response.text();
        return { text, timestamp: Date.now() };
      } else if (this.useOllama) {
        const prompt = `Analyze this audio file and provide a clear, direct description. Be concise and helpful.`;
        const text = await this.callOllama(prompt);
        return { text, timestamp: Date.now() };
      } else {
        throw new Error("No LLM provider configured");
      }
    } catch (error) {
      console.error("Error analyzing audio file:", error);
      throw error;
    }
  }

  public async analyzeAudioFromBase64(data: string, mimeType: string) {
    try {
      if (this.provider === "openai" && this.openaiClient) {
        // Convert base64 to buffer and create a temporary file-like object
        const audioBuffer = Buffer.from(data, 'base64');
        const tempPath = path.join(os.tmpdir(), `audio_${Date.now()}.${mimeType.includes('webm') ? 'webm' : 'mp3'}`);
        await fs.promises.writeFile(tempPath, audioBuffer);
        
        try {
          // Use OpenAI Whisper API for transcription
          const audioFile = fs.createReadStream(tempPath);
          const transcription = await this.openaiClient.audio.transcriptions.create({
            file: audioFile as any,
            model: "whisper-1",
          });
          
          const transcript = transcription.text;
          
          // Clean up temp file
          await fs.promises.unlink(tempPath).catch(() => {});
          
          // Now analyze the transcript
          const response = await this.openaiClient.chat.completions.create({
            model: this.openaiModel,
            messages: [
              { role: "system", content: "You are a helpful AI assistant. Provide clear, direct answers." },
              { role: "user", content: `Here is a transcript of an audio recording: "${transcript}". Please provide a clear, concise summary and analysis of what was said.` }
            ],
            max_tokens: 500
          });
          const text = response.choices[0]?.message?.content || "";
          return { text, timestamp: Date.now() };
        } catch (error) {
          // Clean up temp file on error
          await fs.promises.unlink(tempPath).catch(() => {});
          throw error;
        }
      } else if (this.model) {
        const prompt = `Analyze this audio and provide a clear, direct description. Be concise.`;
        const audioPart = {
          inlineData: {
            data,
            mimeType
          }
        };
        const result = await this.model.generateContent([prompt, audioPart]);
        const response = await result.response;
        const text = response.text();
        return { text, timestamp: Date.now() };
      } else if (this.useOllama) {
        const prompt = `Analyze this audio and provide a clear, direct description. Be concise.`;
        const text = await this.callOllama(prompt);
        return { text, timestamp: Date.now() };
      } else {
        throw new Error("No LLM provider configured");
      }
    } catch (error) {
      console.error("Error analyzing audio from base64:", error);
      throw error;
    }
  }

  public async analyzeImageFile(imagePath: string) {
    try {
      const prompt = `Describe the content of this image clearly and concisely.`;
      
      if (this.provider === "openai" && this.openaiClient) {
        const imageData = await fs.promises.readFile(imagePath);
        const base64Image = imageData.toString("base64");
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/png;base64,${base64Image}`
                  }
                }
              ]
            }
          ],
          max_tokens: 1000
        });
        const text = response.choices[0]?.message?.content || "";
        return { text, timestamp: Date.now() };
      } else if (this.model) {
        const imageData = await fs.promises.readFile(imagePath);
        const imagePart = {
          inlineData: {
            data: imageData.toString("base64"),
            mimeType: "image/png"
          }
        };
        const result = await this.model.generateContent([prompt, imagePart]);
        const response = await result.response;
        const text = response.text();
        return { text, timestamp: Date.now() };
      } else if (this.useOllama) {
        // Ollama doesn't support vision in this implementation, fallback to text
        const text = await this.callOllama(prompt);
        return { text, timestamp: Date.now() };
      } else {
        throw new Error("No LLM provider configured");
      }
    } catch (error) {
      console.error("Error analyzing image file:", error);
      throw error;
    }
  }

  public async chatWithGemini(message: string): Promise<string> {
    try {
      if (this.provider === "openai" && this.openaiClient) {
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [
            { role: "system", content: "You are a helpful AI assistant. Provide clear, direct, and concise answers." },
            { role: "user", content: message }
          ],
          max_tokens: 1000
        });
        const result = response.choices[0]?.message?.content || "";
        console.log("[LLMHelper] OpenAI chat response received");
        return result;
      } else if (this.useOllama) {
        return this.callOllama(message);
      } else if (this.model) {
        const result = await this.model.generateContent(message);
        const response = await result.response;
        return response.text();
      } else {
        throw new Error("No LLM provider configured");
      }
    } catch (error) {
      console.error("[LLMHelper] Error in chat:", error);
      throw error;
    }
  }

  public async chat(message: string): Promise<string> {
    return this.chatWithGemini(message);
  }

  public isUsingOllama(): boolean {
    return this.useOllama;
  }

  public async getOllamaModels(): Promise<string[]> {
    if (!this.useOllama) return [];
    
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`);
      if (!response.ok) throw new Error('Failed to fetch models');
      
      const data = await response.json();
      return data.models?.map((model: any) => model.name) || [];
    } catch (error) {
      console.error("[LLMHelper] Error fetching Ollama models:", error);
      return [];
    }
  }

  public getCurrentProvider(): "ollama" | "gemini" | "openai" {
    return this.provider;
  }

  public getCurrentModel(): string {
    if (this.provider === "openai") return this.openaiModel;
    if (this.provider === "ollama") return this.ollamaModel;
    return "gemini-2.0-flash";
  }

  public async switchToOllama(model?: string, url?: string): Promise<void> {
    this.useOllama = true;
    if (url) this.ollamaUrl = url;
    
    if (model) {
      this.ollamaModel = model;
    } else {
      // Auto-detect first available model
      await this.initializeOllamaModel();
    }
    
    console.log(`[LLMHelper] Switched to Ollama: ${this.ollamaModel} at ${this.ollamaUrl}`);
  }

  public async switchToGemini(apiKey?: string): Promise<void> {
    if (apiKey) {
      const genAI = new GoogleGenerativeAI(apiKey);
      this.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    }
    
    if (!this.model && !apiKey) {
      throw new Error("No Gemini API key provided and no existing model instance");
    }
    
    this.useOllama = false;
    this.provider = "gemini";
    this.openaiClient = null;
    console.log("[LLMHelper] Switched to Gemini");
  }

  public async switchToOpenAI(apiKey?: string, model?: string): Promise<void> {
    if (apiKey) {
      this.openaiClient = new OpenAI({ apiKey });
    }
    
    if (!this.openaiClient && !apiKey) {
      throw new Error("No OpenAI API key provided and no existing client instance");
    }
    
    if (model) {
      this.openaiModel = model;
    }
    
    this.useOllama = false;
    this.provider = "openai";
    this.model = null;
    console.log(`[LLMHelper] Switched to OpenAI (${this.openaiModel})`);
  }

  public async testConnection(): Promise<{ success: boolean; error?: string }> {
    try {
      if (this.provider === "openai") {
        if (!this.openaiClient) {
          return { success: false, error: "No OpenAI client configured" };
        }
        // Test with a simple prompt
        const response = await this.openaiClient.chat.completions.create({
          model: this.openaiModel,
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 10
        });
        if (response.choices[0]?.message?.content) {
          return { success: true };
        } else {
          return { success: false, error: "Empty response from OpenAI" };
        }
      } else if (this.useOllama) {
        const available = await this.checkOllamaAvailable();
        if (!available) {
          return { success: false, error: `Ollama not available at ${this.ollamaUrl}` };
        }
        // Test with a simple prompt
        await this.callOllama("Hello");
        return { success: true };
      } else {
        if (!this.model) {
          return { success: false, error: "No Gemini model configured" };
        }
        // Test with a simple prompt
        const result = await this.model.generateContent("Hello");
        const response = await result.response;
        const text = response.text(); // Ensure the response is valid
        if (text) {
          return { success: true };
        } else {
          return { success: false, error: "Empty response from Gemini" };
        }
      }
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
} 