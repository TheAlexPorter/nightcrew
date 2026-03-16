export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  url: string;
  idList: string;
  labels: { name: string; color: string }[];
  checklists?: TrelloChecklist[];
}

export interface TrelloChecklist {
  name: string;
  checkItems: { name: string; state: "complete" | "incomplete" }[];
}

interface TrelloAction {
  id: string;
  type: string;
  date: string;
  data: { text?: string };
  memberCreator: { username: string };
}

export class TrelloClient {
  private base = "https://api.trello.com/1";

  constructor(private apiKey: string, private token: string) {}

  private auth() {
    return `key=${this.apiKey}&token=${this.token}`;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const sep = path.includes("?") ? "&" : "?";
    const url = `${this.base}${path}${sep}${this.auth()}`;

    const res = await fetch(url, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Trello API ${res.status} on ${path}: ${body}`);
    }

    return res.json() as Promise<T>;
  }

  async getCardsInList(listId: string): Promise<TrelloCard[]> {
    return this.request<TrelloCard[]>(
      `/lists/${listId}/cards?checklists=all&fields=id,name,desc,url,idList,labels`
    );
  }

  async moveCard(cardId: string, listId: string): Promise<void> {
    await this.request(`/cards/${cardId}`, {
      method: "PUT",
      body: JSON.stringify({ idList: listId }),
    });
  }

  async addComment(cardId: string, text: string): Promise<void> {
    await this.request(`/cards/${cardId}/actions/comments`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  async getBoardLists(boardId: string): Promise<{ id: string; name: string }[]> {
    return this.request(`/boards/${boardId}/lists?fields=id,name`);
  }

  /**
   * Fetch the most recent agent plan comment on a card.
   * Used during the approved → execute pass to recover the plan.
   */
  async getLatestPlanComment(cardId: string): Promise<string | null> {
    const actions = await this.request<TrelloAction[]>(
      `/cards/${cardId}/actions?filter=commentCard&limit=50`
    );

    // Find the most recent comment that contains the plan header
    const planComment = actions.find((a) =>
      a.data.text?.includes("## 🤖 Proposed Implementation Plan")
    );

    if (!planComment?.data.text) return null;

    // Strip the header and footer lines, return just the plan body
    const lines = planComment.data.text.split("\n");
    const start = lines.findIndex((l) => l.startsWith("## 🤖")) + 1;
    const end = lines.findIndex((l) => l.startsWith("---"));
    return lines.slice(start, end > start ? end : undefined).join("\n").trim();
  }

  /** Helper to resolve list names → IDs (useful during setup) */
  async resolveListIds(
    boardId: string,
    names: {
      queue: string;
      inProgress: string;
      planReview: string;
      approved: string;
      humanReview: string;
    }
  ) {
    const lists = await this.getBoardLists(boardId);
    const find = (name: string) => {
      const found = lists.find(
        (l) => l.name.toLowerCase() === name.toLowerCase()
      );
      if (!found)
        throw new Error(
          `List "${name}" not found. Available: ${lists.map((l) => l.name).join(", ")}`
        );
      return found.id;
    };

    return {
      queueListId: find(names.queue),
      inProgressListId: find(names.inProgress),
      planReviewListId: find(names.planReview),
      approvedListId: find(names.approved),
      humanReviewListId: find(names.humanReview),
    };
  }
}
