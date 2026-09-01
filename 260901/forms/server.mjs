import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { google } from "googleapis";
import { z } from "zod";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

// --------------------------------------------------
// 기본 설정
// --------------------------------------------------

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const credentialsPath = path.resolve(
  __dirname,
  process.env.GOOGLE_APPLICATION_CREDENTIALS ||
    "C:/Users/user/Documents/Userearch_260901/forms/credentials.json",
);

if (!fs.existsSync(credentialsPath)) {
  throw new Error(
    `credentials.json 파일을 찾을 수 없습니다: ${credentialsPath}`,
  );
}

const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf-8"));

const SCOPES = [
  "https://www.googleapis.com/auth/forms.body",
  "https://www.googleapis.com/auth/forms.responses.readonly",
  "https://www.googleapis.com/auth/drive",
];

// --------------------------------------------------
// Google 인증
// --------------------------------------------------

function createGoogleAuth() {
  const impersonateUser = process.env.GOOGLE_IMPERSONATE_USER?.trim();

  // Google Workspace Domain-wide Delegation
  if (impersonateUser) {
    return new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: SCOPES,
      subject: impersonateUser,
    });
  }

  // 일반 Service Account
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}

const auth = createGoogleAuth();

const forms = google.forms({
  version: "v1",
  auth,
});

// --------------------------------------------------
// MCP 서버
// --------------------------------------------------

const server = new McpServer({
  name: "google-forms-mcp",
  version: "1.0.0",
});

// --------------------------------------------------
// 공통 함수
// --------------------------------------------------

function success(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
  };
}

function failure(error) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: true,
            message: error?.message || String(error),
            details: error?.response?.data || null,
          },
          null,
          2,
        ),
      },
    ],
    isError: true,
  };
}

// --------------------------------------------------
// Question 변환 함수
// --------------------------------------------------

function createQuestionItem(question) {
  const baseQuestion = {
    required: question.required ?? false,
  };

  switch (question.type) {
    case "text":
      return {
        title: question.title,
        description: question.description || undefined,
        questionItem: {
          question: {
            ...baseQuestion,
            textQuestion: {
              paragraph: question.paragraph ?? false,
            },
          },
        },
      };

    case "radio":
      return {
        title: question.title,
        description: question.description || undefined,
        questionItem: {
          question: {
            ...baseQuestion,
            choiceQuestion: {
              type: "RADIO",
              options: question.options.map((value) => ({
                value,
              })),
              shuffle: question.shuffle ?? false,
            },
          },
        },
      };

    case "checkbox":
      return {
        title: question.title,
        description: question.description || undefined,
        questionItem: {
          question: {
            ...baseQuestion,
            choiceQuestion: {
              type: "CHECKBOX",
              options: question.options.map((value) => ({
                value,
              })),
              shuffle: question.shuffle ?? false,
            },
          },
        },
      };

    case "dropdown":
      return {
        title: question.title,
        description: question.description || undefined,
        questionItem: {
          question: {
            ...baseQuestion,
            choiceQuestion: {
              type: "DROP_DOWN",
              options: question.options.map((value) => ({
                value,
              })),
              shuffle: question.shuffle ?? false,
            },
          },
        },
      };

    case "scale":
      return {
        title: question.title,
        description: question.description || undefined,
        questionItem: {
          question: {
            ...baseQuestion,
            scaleQuestion: {
              low: question.low,
              high: question.high,
              lowLabel: question.lowLabel || "",
              highLabel: question.highLabel || "",
            },
          },
        },
      };

    default:
      throw new Error(`지원하지 않는 질문 타입입니다: ${question.type}`);
  }
}

// ==================================================
// TOOL 1. Form 조회
// ==================================================

server.registerTool(
  "get_form",
  {
    title: "Get Google Form",
    description:
      "Google Form ID를 사용하여 Form 제목, 설명, 질문 구조와 설정을 조회합니다.",
    inputSchema: {
      form_id: z.string().min(1),
    },
  },
  async ({ form_id }) => {
    try {
      const response = await forms.forms.get({
        formId: form_id,
      });

      return success(response.data);
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 2. 빈 Form 생성
// ==================================================

server.registerTool(
  "create_form",
  {
    title: "Create Google Form",
    description:
      "새 Google Form을 생성합니다. Service Account 단독 인증에서는 파일 소유권 제한 때문에 실패할 수 있으며 Workspace Domain-wide Delegation 사용을 권장합니다.",
    inputSchema: {
      title: z.string().min(1),
      document_title: z.string().optional(),
    },
  },
  async ({ title, document_title }) => {
    try {
      const response = await forms.forms.create({
        requestBody: {
          info: {
            title,
            documentTitle: document_title || title,
          },
        },
      });

      return success({
        message: "Google Form이 생성되었습니다.",
        formId: response.data.formId,
        responderUri: response.data.responderUri,
        form: response.data,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 3. 제목 / 설명 수정
// ==================================================

server.registerTool(
  "update_form_info",
  {
    title: "Update Google Form Info",
    description: "Google Form의 제목 또는 설명을 수정합니다.",
    inputSchema: {
      form_id: z.string(),
      title: z.string().optional(),
      description: z.string().optional(),
    },
  },
  async ({ form_id, title, description }) => {
    try {
      const info = {};
      const mask = [];

      if (title !== undefined) {
        info.title = title;
        mask.push("title");
      }

      if (description !== undefined) {
        info.description = description;
        mask.push("description");
      }

      if (mask.length === 0) {
        throw new Error("title 또는 description 중 하나는 필요합니다.");
      }

      const response = await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          includeFormInResponse: true,
          requests: [
            {
              updateFormInfo: {
                info,
                updateMask: mask.join(","),
              },
            },
          ],
        },
      });

      return success(response.data);
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 4. 단답형 / 장문형 질문 추가
// ==================================================

server.registerTool(
  "add_text_question",
  {
    title: "Add Text Question",
    description: "Google Form에 단답형 또는 장문형 질문을 추가합니다.",
    inputSchema: {
      form_id: z.string(),
      title: z.string(),
      description: z.string().optional(),
      required: z.boolean().default(false),
      paragraph: z.boolean().default(false),
    },
  },
  async ({ form_id, title, description, required, paragraph }) => {
    try {
      const form = await forms.forms.get({
        formId: form_id,
      });

      const index = form.data.items?.length || 0;

      const response = await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          includeFormInResponse: true,
          requests: [
            {
              createItem: {
                item: {
                  title,
                  description,
                  questionItem: {
                    question: {
                      required,
                      textQuestion: {
                        paragraph,
                      },
                    },
                  },
                },
                location: {
                  index,
                },
              },
            },
          ],
        },
      });

      return success(response.data);
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 5. 객관식 질문 추가
// ==================================================

server.registerTool(
  "add_choice_question",
  {
    title: "Add Choice Question",
    description:
      "Google Form에 객관식, 체크박스 또는 드롭다운 질문을 추가합니다.",
    inputSchema: {
      form_id: z.string(),
      title: z.string(),
      description: z.string().optional(),

      type: z.enum(["RADIO", "CHECKBOX", "DROP_DOWN"]),

      options: z.array(z.string()).min(1),

      required: z.boolean().default(false),
      shuffle: z.boolean().default(false),
    },
  },
  async ({ form_id, title, description, type, options, required, shuffle }) => {
    try {
      const form = await forms.forms.get({
        formId: form_id,
      });

      const index = form.data.items?.length || 0;

      const response = await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          includeFormInResponse: true,
          requests: [
            {
              createItem: {
                item: {
                  title,
                  description,
                  questionItem: {
                    question: {
                      required,
                      choiceQuestion: {
                        type,
                        options: options.map((value) => ({
                          value,
                        })),
                        shuffle,
                      },
                    },
                  },
                },
                location: {
                  index,
                },
              },
            },
          ],
        },
      });

      return success(response.data);
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 6. 척도 질문 추가
// ==================================================

server.registerTool(
  "add_scale_question",
  {
    title: "Add Scale Question",
    description: "1~5, 1~10과 같은 Google Form 선형 배율 질문을 추가합니다.",
    inputSchema: {
      form_id: z.string(),
      title: z.string(),
      low: z.number().int().min(0).max(10),
      high: z.number().int().min(1).max(10),
      low_label: z.string().optional(),
      high_label: z.string().optional(),
      required: z.boolean().default(false),
    },
  },
  async ({ form_id, title, low, high, low_label, high_label, required }) => {
    try {
      const form = await forms.forms.get({
        formId: form_id,
      });

      const index = form.data.items?.length || 0;

      const response = await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          includeFormInResponse: true,
          requests: [
            {
              createItem: {
                item: {
                  title,
                  questionItem: {
                    question: {
                      required,
                      scaleQuestion: {
                        low,
                        high,
                        lowLabel: low_label || "",
                        highLabel: high_label || "",
                      },
                    },
                  },
                },
                location: {
                  index,
                },
              },
            },
          ],
        },
      });

      return success(response.data);
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 7. 질문 삭제
// ==================================================

server.registerTool(
  "delete_question",
  {
    title: "Delete Google Form Question",
    description: "Google Form의 특정 Item ID를 찾아 해당 질문을 삭제합니다.",
    inputSchema: {
      form_id: z.string(),
      item_id: z.string(),
    },
  },
  async ({ form_id, item_id }) => {
    try {
      const formResponse = await forms.forms.get({
        formId: form_id,
      });

      const items = formResponse.data.items || [];

      const index = items.findIndex((item) => item.itemId === item_id);

      if (index === -1) {
        throw new Error(`item_id ${item_id}를 찾지 못했습니다.`);
      }

      const response = await forms.forms.batchUpdate({
        formId: form_id,
        requestBody: {
          requests: [
            {
              deleteItem: {
                location: {
                  index,
                },
              },
            },
          ],
        },
      });

      return success({
        message: "질문이 삭제되었습니다.",
        itemId: item_id,
        deletedIndex: index,
        response: response.data,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 8. Form 응답 조회
// ==================================================

server.registerTool(
  "list_form_responses",
  {
    title: "List Google Form Responses",
    description: "Google Form에 제출된 응답 데이터를 조회합니다.",
    inputSchema: {
      form_id: z.string(),
      page_size: z.number().int().min(1).max(500).default(100),
    },
  },
  async ({ form_id, page_size }) => {
    try {
      const allResponses = [];

      let pageToken = undefined;

      do {
        const response = await forms.forms.responses.list({
          formId: form_id,
          pageSize: page_size,
          pageToken,
        });

        if (response.data.responses) {
          allResponses.push(...response.data.responses);
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

      return success({
        count: allResponses.length,
        responses: allResponses,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

// ==================================================
// TOOL 9. Form + 질문 전체 자동 생성
// ==================================================

const QuestionSchema = z.object({
  type: z.enum(["text", "radio", "checkbox", "dropdown", "scale"]),

  title: z.string(),

  description: z.string().optional(),

  required: z.boolean().optional(),

  paragraph: z.boolean().optional(),

  options: z.array(z.string()).optional(),

  shuffle: z.boolean().optional(),

  low: z.number().int().optional(),
  high: z.number().int().optional(),

  lowLabel: z.string().optional(),
  highLabel: z.string().optional(),
});

server.registerTool(
  "create_complete_form",
  {
    title: "Create Complete Google Form",
    description:
      "제목, 설명, 여러 질문을 한 번에 받아 완성된 Google Form을 자동 생성합니다.",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      questions: z.array(QuestionSchema).min(1),
    },
  },
  async ({ title, description, questions }) => {
    try {
      // 1. Form 생성
      const createResponse = await forms.forms.create({
        requestBody: {
          info: {
            title,
            documentTitle: title,
          },
        },
      });

      const formId = createResponse.data.formId;

      if (!formId) {
        throw new Error("Form ID를 가져오지 못했습니다.");
      }

      const requests = [];

      // 2. Form 설명 추가
      if (description) {
        requests.push({
          updateFormInfo: {
            info: {
              description,
            },
            updateMask: "description",
          },
        });
      }

      // 3. 질문 추가
      questions.forEach((question, index) => {
        if (
          ["radio", "checkbox", "dropdown"].includes(question.type) &&
          (!question.options || question.options.length === 0)
        ) {
          throw new Error(`"${question.title}" 질문에는 options가 필요합니다.`);
        }

        if (
          question.type === "scale" &&
          (question.low === undefined || question.high === undefined)
        ) {
          throw new Error(
            `"${question.title}" 질문에는 low와 high가 필요합니다.`,
          );
        }

        requests.push({
          createItem: {
            item: createQuestionItem(question),
            location: {
              index,
            },
          },
        });
      });

      // 4. 질문 / 설명 일괄 적용
      const updateResponse = await forms.forms.batchUpdate({
        formId,
        requestBody: {
          includeFormInResponse: true,
          requests,
        },
      });

      return success({
        message: "완성된 Google Form이 생성되었습니다.",
        formId,
        responderUri:
          updateResponse.data.form?.responderUri ||
          createResponse.data.responderUri,
        editUrl: `https://docs.google.com/forms/d/${formId}/edit`,
        form: updateResponse.data.form,
      });
    } catch (error) {
      return failure(error);
    }
  },
);

// --------------------------------------------------
// 서버 시작
// --------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();

  await server.connect(transport);

  // stdio MCP에서는 console.log 사용 금지
  // JSON-RPC 통신에 영향을 줄 수 있음
  console.error("Google Forms MCP Server started");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
