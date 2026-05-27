const { GoogleGenerativeAI } = require("@google/generative-ai");
require('dotenv').config();

const test = async () => {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  const models = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  
  for (const m of models) {
    try {
      console.log(`Testing model: ${m}...`);
      const model = genAI.getGenerativeModel({ model: m });
      const result = await model.generateContent("hello");
      const text = result.response.text();
      console.log(`✅ Success with model ${m}: "${text.trim()}"`);
      return;
    } catch (err) {
      console.log(`❌ Failed with model ${m}: ${err.message}`);
    }
  }
};

test();
