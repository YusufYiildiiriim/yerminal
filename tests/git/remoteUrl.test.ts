import { describe, expect, it } from "vitest";
import { suggestRepoName, validateRemoteName, validateRemoteUrl, validateRepoName } from "../../src/features/git/remoteUrl";

describe("remote URL validation", () => {
  it("accepts https, ssh:// and git@host:path forms", () => {
    for (const url of [
      "https://github.com/owner/repo.git",
      "https://gitlab.example.com:8443/group/repo",
      "ssh://git@github.com/owner/repo.git",
      "ssh://git@example.com:2222/owner/repo.git",
      "git@github.com:owner/repo.git",
    ]) {
      expect(validateRemoteUrl(url), url).toBeNull();
    }
  });

  it("rejects empty, malformed, whitespace and option-like URLs", () => {
    for (const url of ["", "   ", "not a url", "ftp://example.com/repo.git", "https://", "https://host/with space.git", "--upload-pack=touch x", "-oProxyCommand=calc", "git@-host:repo.git"]) {
      expect(validateRemoteUrl(url), url).toEqual(expect.any(String));
    }
  });

  it("accepts a plain remote name and rejects names that are not plain", () => {
    expect(validateRemoteName("origin")).toBeNull();
    expect(validateRemoteName("my.remote_1")).toBeNull();
    for (const name of ["", "-x", "--all", "a b", "origin/x", "a..b"]) {
      expect(validateRemoteName(name), name).toEqual(expect.any(String));
    }
  });
});

describe("GitHub repository name", () => {
  it("accepts plain GitHub names and rejects spaces, slashes, dashes at the start and dot names", () => {
    for (const name of ["yerminal", "my-repo", "my.repo_2"]) expect(validateRepoName(name), name).toBeNull();
    for (const name of ["", "  ", "a b", "owner/repo", "-x", ".", "..", "naïve"]) {
      expect(validateRepoName(name), name).toEqual(expect.any(String));
    }
  });

  it("suggests a GitHub-safe name from the folder name", () => {
    expect(suggestRepoName("my project")).toBe("my-project");
    expect(suggestRepoName("yerminal")).toBe("yerminal");
    expect(suggestRepoName("-hidden")).toBe("hidden");
    expect(suggestRepoName("ğüş")).toBe("repository");
    expect(suggestRepoName("")).toBe("repository");
  });
});
