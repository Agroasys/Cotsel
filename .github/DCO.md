# Developer Certificate of Origin (DCO)

This repository requires DCO sign-off on every commit in pull requests.

## What this means

By signing off a commit, you certify that you have the right to submit the work under this project's license.

## How to sign a new commit

```bash
git commit -s -m "fix(scope): summary"
```

## How to add sign-off to an existing commit

```bash
git commit --amend -s --no-edit
```

## How to fix multiple commits

```bash
git rebase --signoff origin/main
```

If manual fixup is needed:

```bash
git rebase -i origin/main
# mark commits as edit
# for each commit:
git commit --amend -s --no-edit
git rebase --continue
```

## Enforcement

A pull request DCO workflow checks commit sign-offs automatically.
