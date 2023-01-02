# noid.dev

This repository hosts multiple projects under the [noid.dev](https://noid.dev) domain on
respective subpaths. All coming updates are auto-fetched daily and combined into a PR approved by
code owners.

| Project                                      | URL                               |
|----------------------------------------------|-----------------------------------|
| https://github.com/noid-dev/codewars-openapi | https://noid.dev/codewars-openapi |

## Development

To link new project, run:

```
git submodule add -b gh-pages <remote-repo>
```

To pull updates from all linked projects, run:

```
git pull --recurse-submodules
git submodule update --remote --recursive
```

To remove project link, run:

```
git rm <path-to-submodule>, and commit.
```